import {
  extractGroundableEntities,
  type ExtractedEntity,
} from "@/lib/entity-extractor";
import { tavilySearch, type TavilyResult } from "@/lib/tavily-client";

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
};

const groundingSessions = new Map<string, GroundingSessionState>();
const budgetExhaustionLoggedSessions = new Set<string>();
const SESSION_TTL_MS = 30 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60_000;
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
  };

  groundingSessions.set(normalizedSessionId, nextState);
  return nextState;
};

const composeQuery = (entity: ExtractedEntity) => {
  if (
    entity.type === "cloud_service" ||
    entity.type === "tech_stack" ||
    entity.type === "standard" ||
    entity.type === "metric"
  ) {
    return `${entity.name} ${entity.context}`.trim();
  }

  return entity.context ? `${entity.name} ${entity.context}`.trim() : entity.name;
};

const cacheKeyFor = (entity: ExtractedEntity) =>
  `${entity.name.toLowerCase().trim()}::${entity.context.toLowerCase().trim()}`.slice(0, 200);

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
    };
  }

  return {
    searches_used: sessionState.searchesUsed,
    searches_remaining: remainingSearches(sessionState.searchesUsed),
    cache_size: sessionState.cache.size,
    last_touched_at: sessionState.lastTouchedAt,
  };
}

export function resetGroundingSession(sessionId: string) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  groundingSessions.delete(normalizedSessionId);
  budgetExhaustionLoggedSessions.delete(normalizedSessionId);
}

export async function fetchGroundingFor(
  groqApiKey: string,
  verbatimText: string,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<GroundingResult> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const emptyResult = (
    overrides: Partial<GroundingResult> = {},
  ): GroundingResult => {
    const sessionState = groundingSessions.get(normalizedSessionId);
    const searchesUsed = sessionState?.searchesUsed ?? 0;

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

  if (abortSignal?.aborted) {
    return emptyResult();
  }

  if (process.env.TAVILY_ENABLED !== "true") {
    return emptyResult({
      searches_used: 0,
      searches_remaining: 0,
      skipped_reason: "disabled",
    });
  }

  if (!process.env.TAVILY_API_KEY?.trim()) {
    return emptyResult({
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

  if (abortSignal?.aborted) {
    return emptyResult();
  }

  if (entities.length === 0) {
    const sessionState = getSessionState(sessionId);
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

  const sessionState = getSessionState(sessionId);
  sessionState.lastTouchedAt = Date.now();
  const facts: GroundedFact[] = [];
  const cacheHits = { count: 0 };
  const misses: Array<{ key: string; query: string; entityName: string; scope: string }> = [];

  for (const entity of entities) {
    const key = cacheKeyFor(entity);
    const cached = sessionState.cache.get(key);

    if (cached !== undefined) {
      cacheHits.count += 1;
      if (cached) {
        facts.push({
          entity: entity.name,
          scope: entity.context,
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
      query: composeQuery(entity),
      entityName: entity.name,
      scope: entity.context,
    });
  }

  if (misses.length > 0 && sessionState.searchesUsed >= maxSearchesPerSession()) {
    if (!budgetExhaustionLoggedSessions.has(normalizedSessionId)) {
      budgetExhaustionLoggedSessions.add(normalizedSessionId);
      console.warn("[grounding] tavily disabled (budget exhausted), continuing without facts");
    }
    return {
      facts: [],
      entities: entities.map((entity) => entity.name),
      searches_used: sessionState.searchesUsed,
      searches_remaining: remainingSearches(sessionState.searchesUsed),
      cache_hits: cacheHits.count,
      skipped_reason: "cap_reached",
      entities_found: entities.length,
    };
  }

  const allowedMisses = misses.slice(0, Math.max(0, maxSearchesPerSession() - sessionState.searchesUsed));

  sessionState.searchesUsed += allowedMisses.length;

  let settled: PromiseSettledResult<{
    key: string;
    entityName: string;
    scope: string;
    result: TavilyResult | null;
  }>[] = [];

  try {
    settled = await Promise.allSettled(
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
            abortSignal,
            timeoutMs: parsePositiveInt(process.env.TAVILY_TIMEOUT_MS, 2_000),
          }),
        };
      }),
    );
  } catch (error) {
    if (!abortSignal?.aborted) {
      console.warn("[grounding] tavily unavailable, continuing without facts", {
        reason: error instanceof Error ? error.name || error.message : String(error),
      });
    }
    return {
      facts: [],
      entities: entities.map((entity) => entity.name),
      searches_used: sessionState.searchesUsed,
      searches_remaining: remainingSearches(sessionState.searchesUsed),
      cache_hits: cacheHits.count,
      entities_found: entities.length,
    };
  }

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
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
      continue;
    }

    // The Tavily client already fail-opens to null; this branch is defensive.
  }

  return emptyResult({
    facts,
    entities: entities.map((entity) => entity.name),
    searches_used: sessionState.searchesUsed,
    searches_remaining: remainingSearches(sessionState.searchesUsed),
    cache_hits: cacheHits.count,
    skipped_reason:
      allowedMisses.length < misses.length ? "cap_reached" : undefined,
    entities_found: entities.length,
  });
}
