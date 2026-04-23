import {
  extractGroundableEntities,
  type ExtractedEntity,
} from "@/lib/entity-extractor";
import { tavilySearch, type TavilyResult } from "@/lib/tavily-client";
import type { PromptGroundedFact } from "@/lib/prompts";

export interface GroundedFact {
  entity: string;
  scope: string;
  fact: string;
  url: string;
  title: string;
  published_date?: string;
}

export interface GroundingResult {
  facts: GroundedFact[];
  entities: string[];
  searches_used: number;
  searches_remaining: number;
  cache_hits: number;
  skipped_reason?: "disabled" | "no_api_key" | "cap_reached" | "no_entities";
  entities_found?: number;
}

type GroundingSessionState = {
  cache: Map<string, TavilyResult | null>;
  searchesUsed: number;
  lastTouchedAt: number;
  lastCacheHits: number;
  lastSkippedReason?: GroundingResult["skipped_reason"];
};

const groundingSessions = new Map<string, GroundingSessionState>();
const budgetExhaustionLoggedSessions = new Set<string>();
const SESSION_TTL_MS = 30 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_GROUNDED_ENTITIES_PER_BATCH = 2;
const DEFAULT_TAVILY_TIMEOUT_MS = 1_500;
let lastGroundingSweepAt = 0;

const normalizeSessionId = (sessionId: string) => sessionId.trim() || "default";

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const sweepExpiredSessions = () => {
  const now = Date.now();

  if (now - lastGroundingSweepAt < SESSION_SWEEP_INTERVAL_MS) {
    return;
  }

  lastGroundingSweepAt = now;

  groundingSessions.forEach((state, key) => {
    if (now - state.lastTouchedAt > SESSION_TTL_MS) {
      groundingSessions.delete(key);
      budgetExhaustionLoggedSessions.delete(key);
    }
  });
};

const getSessionState = (sessionId: string): GroundingSessionState => {
  sweepExpiredSessions();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const existingState = groundingSessions.get(normalizedSessionId);

  if (existingState) {
    existingState.lastTouchedAt = Date.now();
    return existingState;
  }

  const nextState: GroundingSessionState = {
    cache: new Map(),
    searchesUsed: 0,
    lastTouchedAt: Date.now(),
    lastCacheHits: 0,
    lastSkippedReason: undefined,
  };

  groundingSessions.set(normalizedSessionId, nextState);
  return nextState;
};

const resolveEntityScope = (
  entity: Pick<ExtractedEntity, "context">,
  fallbackScope?: string,
) => entity.context.trim() || fallbackScope?.trim() || "";

const composeQuery = (entity: ExtractedEntity, fallbackScope?: string) => {
  const resolvedScope = resolveEntityScope(entity, fallbackScope);

  if (
    entity.type === "cloud_service" ||
    entity.type === "tech_stack" ||
    entity.type === "standard" ||
    entity.type === "metric"
  ) {
    return `${entity.name} ${resolvedScope}`.trim();
  }

  return resolvedScope ? `${entity.name} ${resolvedScope}`.trim() : entity.name;
};

const cacheKeyFor = (entity: ExtractedEntity, fallbackScope?: string) =>
  `${entity.name.toLowerCase().trim()}::${resolveEntityScope(entity, fallbackScope).toLowerCase()}`.slice(0, 200);

const maxSearchesPerSession = () =>
  parsePositiveInt(process.env.MAX_TAVILY_SEARCHES_PER_SESSION, 30);

const remainingSearches = (searchesUsed: number) =>
  Math.max(0, maxSearchesPerSession() - searchesUsed);

export function getGroundingStats(sessionId: string) {
  sweepExpiredSessions();
  const sessionState = groundingSessions.get(normalizeSessionId(sessionId));

  if (!sessionState) {
    return {
      searches_used: 0,
      searches_remaining: maxSearchesPerSession(),
      cache_size: 0,
      last_touched_at: null,
      last_cache_hits: 0,
      last_skipped_reason: undefined,
    };
  }

  return {
    searches_used: sessionState.searchesUsed,
    searches_remaining: remainingSearches(sessionState.searchesUsed),
    cache_size: sessionState.cache.size,
    last_touched_at: sessionState.lastTouchedAt,
    last_cache_hits: sessionState.lastCacheHits,
    last_skipped_reason: sessionState.lastSkippedReason,
  };
}

type FetchGroundedFactsParams = {
  entities: ExtractedEntity[];
  scope: string;
  sessionId: string;
  signal?: AbortSignal;
};

const emptyResultForSession = (
  normalizedSessionId: string,
  overrides: Partial<GroundingResult> = {},
): GroundingResult => {
  const sessionState = groundingSessions.get(normalizedSessionId);
  const searchesUsed = sessionState?.searchesUsed ?? 0;

  if (sessionState) {
    sessionState.lastCacheHits = overrides.cache_hits ?? 0;
    sessionState.lastSkippedReason = overrides.skipped_reason;
  }

  return {
    facts: [],
    entities: [],
    searches_used: searchesUsed,
    searches_remaining: remainingSearches(searchesUsed),
    cache_hits: 0,
    entities_found: 0,
    ...overrides,
  };
};

async function fetchGroundingForEntities(
  params: FetchGroundedFactsParams,
): Promise<GroundingResult> {
  const normalizedSessionId = normalizeSessionId(params.sessionId);

  if (params.signal?.aborted) {
    return emptyResultForSession(normalizedSessionId);
  }

  if (process.env.TAVILY_ENABLED !== "true") {
    return emptyResultForSession(normalizedSessionId, {
      searches_used: 0,
      searches_remaining: 0,
      skipped_reason: "disabled",
    });
  }

  if (!process.env.TAVILY_API_KEY?.trim()) {
    return emptyResultForSession(normalizedSessionId, {
      searches_used: 0,
      searches_remaining: 0,
      skipped_reason: "no_api_key",
    });
  }

  const dedupedEntities = Array.from(
    new Map(
      params.entities
        .filter((entity) => entity.name.trim().length > 0)
        .map((entity) => [cacheKeyFor(entity, params.scope), entity] as const),
    ).values(),
  ).slice(0, MAX_GROUNDED_ENTITIES_PER_BATCH);

  if (dedupedEntities.length === 0) {
    const sessionState = getSessionState(params.sessionId);
    sessionState.lastCacheHits = 0;
    sessionState.lastSkippedReason = "no_entities";
    return {
      facts: [],
      entities: [],
      searches_used: sessionState.searchesUsed,
      searches_remaining: remainingSearches(sessionState.searchesUsed),
      cache_hits: 0,
      skipped_reason: "no_entities",
      entities_found: 0,
    };
  }

  const sessionState = getSessionState(params.sessionId);
  sessionState.lastTouchedAt = Date.now();
  const facts: GroundedFact[] = [];
  let cacheHits = 0;
  const misses: Array<{
    key: string;
    query: string;
    entityName: string;
    scope: string;
  }> = [];

  for (const entity of dedupedEntities) {
    const resolvedScope = resolveEntityScope(entity, params.scope);
    const key = cacheKeyFor(entity, params.scope);
    const cached = sessionState.cache.get(key);

    if (cached !== undefined) {
      cacheHits += 1;
      if (cached) {
        facts.push({
          entity: entity.name,
          scope: resolvedScope,
          fact: cached.fact,
          url: cached.url,
          title: cached.title,
          published_date: cached.published_date,
        });
      }
      continue;
    }

    misses.push({
      key,
      query: composeQuery(entity, params.scope),
      entityName: entity.name,
      scope: resolvedScope,
    });
  }

  if (misses.length > 0 && sessionState.searchesUsed >= maxSearchesPerSession()) {
    if (!budgetExhaustionLoggedSessions.has(normalizedSessionId)) {
      budgetExhaustionLoggedSessions.add(normalizedSessionId);
      console.warn("[grounding] tavily disabled (budget exhausted), continuing without facts");
    }
    sessionState.lastCacheHits = cacheHits;
    sessionState.lastSkippedReason = "cap_reached";
    return {
      facts,
      entities: dedupedEntities.map((entity) => entity.name),
      searches_used: sessionState.searchesUsed,
      searches_remaining: remainingSearches(sessionState.searchesUsed),
      cache_hits: cacheHits,
      skipped_reason: "cap_reached",
      entities_found: dedupedEntities.length,
    };
  }

  const allowedMisses = misses.slice(
    0,
    Math.max(0, maxSearchesPerSession() - sessionState.searchesUsed),
  );

  sessionState.searchesUsed += allowedMisses.length;

  try {
    const settled = await Promise.allSettled(
      allowedMisses.map(async (miss) => {
        console.info("[grounding] tavily query", {
          entity: miss.entityName,
          query: miss.query,
          scope: miss.scope,
          session_id: normalizedSessionId,
        });

        return {
          key: miss.key,
          entityName: miss.entityName,
          scope: miss.scope,
          result: await tavilySearch(miss.query, {
            entity: miss.entityName,
            scope: miss.scope,
            abortSignal: params.signal,
            timeoutMs: parsePositiveInt(process.env.TAVILY_TIMEOUT_MS, DEFAULT_TAVILY_TIMEOUT_MS),
          }),
        };
      }),
    );

    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") {
        continue;
      }

      const { entityName, key, result, scope } = outcome.value;
      sessionState.cache.set(key, result);

      if (result) {
        facts.push({
          entity: entityName,
          scope,
          fact: result.fact,
          url: result.url,
          title: result.title,
          published_date: result.published_date,
        });
      }
    }
  } catch (error) {
    if (!params.signal?.aborted) {
      console.warn("[grounding] tavily unavailable, continuing without facts", {
        reason: error instanceof Error ? error.name || error.message : String(error),
      });
    }
    sessionState.lastCacheHits = cacheHits;
    sessionState.lastSkippedReason = undefined;
    return {
      facts: [],
      entities: dedupedEntities.map((entity) => entity.name),
      searches_used: sessionState.searchesUsed,
      searches_remaining: remainingSearches(sessionState.searchesUsed),
      cache_hits: cacheHits,
      entities_found: dedupedEntities.length,
    };
  }

  sessionState.lastCacheHits = cacheHits;
  sessionState.lastSkippedReason =
    allowedMisses.length < misses.length ? "cap_reached" : undefined;

  return {
    facts,
    entities: dedupedEntities.map((entity) => entity.name),
    searches_used: sessionState.searchesUsed,
    searches_remaining: remainingSearches(sessionState.searchesUsed),
    cache_hits: cacheHits,
    skipped_reason:
      allowedMisses.length < misses.length ? "cap_reached" : undefined,
    entities_found: dedupedEntities.length,
  };
}

export async function fetchGroundedFacts(
  params: FetchGroundedFactsParams,
): Promise<PromptGroundedFact[]> {
  const result = await fetchGroundingForEntities(params);
  return result.facts;
}

export async function fetchGroundingFor(
  groqApiKey: string,
  verbatimText: string,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<GroundingResult> {
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (abortSignal?.aborted) {
    return emptyResultForSession(normalizedSessionId);
  }

  if (process.env.TAVILY_ENABLED !== "true") {
    return emptyResultForSession(normalizedSessionId, {
      searches_used: 0,
      searches_remaining: 0,
      skipped_reason: "disabled",
    });
  }

  if (!process.env.TAVILY_API_KEY?.trim()) {
    return emptyResultForSession(normalizedSessionId, {
      searches_used: 0,
      searches_remaining: 0,
      skipped_reason: "no_api_key",
    });
  }

  let entities: ExtractedEntity[] = [];

  try {
    entities = await extractGroundableEntities(groqApiKey, verbatimText, abortSignal);
  } catch (error) {
    console.warn("[grounding] entity extraction failed", {
      message: error instanceof Error ? error.message : String(error),
      session_id: normalizeSessionId(sessionId),
    });
    entities = [];
  }

  const normalizedVerbatim = verbatimText.toLowerCase();
  entities = entities
    .filter((entity) => normalizedVerbatim.includes(entity.name.toLowerCase().trim()))
    .slice(0, MAX_GROUNDED_ENTITIES_PER_BATCH);

  if (abortSignal?.aborted) {
    return emptyResultForSession(normalizedSessionId);
  }

  const facts = await fetchGroundedFacts({
    entities,
    scope: verbatimText,
    sessionId,
    signal: abortSignal,
  });
  const stats = getGroundingStats(sessionId);

  return {
    facts,
    entities: entities.map((entity) => entity.name),
    searches_used: stats.searches_used,
    searches_remaining: stats.searches_remaining,
    cache_hits: stats.last_cache_hits ?? 0,
    skipped_reason: stats.last_skipped_reason,
    entities_found: entities.length,
  };
}
