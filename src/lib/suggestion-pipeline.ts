// ---------------------------------------------------------------------------
// Two-call suggestion pipeline
//
// Call A (candidate generation): one non-streaming JSON completion that
// returns 6 candidates spanning types. Fast, generous max_tokens so breadth
// isn't truncated.
//
// Call B (critique + rank): one streaming JSON completion that selects and
// rewrites exactly 3 finals with enforced diversity. Streaming is used so
// each final card appears in the UI as soon as it completes — the perceived
// latency win that justifies the extra call.
//
// Fallback ladder:
//   - Call A failure            → emit `error` frame, stream closes.
//   - Call A took > 14s         → skip B, emit first 3 candidates raw.
//   - Call B failure            → emit first 3 candidates raw (warn log).
//   - Call B diversity violation → corrective retry of B once; if still
//                                  invalid, fall back to raw candidates.
// ---------------------------------------------------------------------------

import Groq from "groq-sdk";
import OpenAI from "openai";
import {
  getLargeModelClient,
  getLargeModelName,
  isLargeModelExpandedContext,
} from "@/lib/llm-clients";
import {
  buildCandidatesPrompt,
  buildCritiquePrompt,
  DEFAULT_CONTEXT_WINDOWS,
} from "@/lib/prompts";
import { fetchGroundingFor, type GroundedFact } from "@/lib/grounding";
import {
  extractCompletedArrayElements,
  extractMetaBlock,
} from "@/lib/streaming-json";
import {
  coerceStreamedCard,
  extractAssistantText,
  extractJsonObject,
  getSuggestionsTimeoutMs,
  isValidSuggestionType,
  normalizeSuggestion,
  SuggestionGenerationError,
  SuggestionsStreamParser,
  SUGGESTION_TYPES,
  validateSuggestions,
} from "@/lib/groq-client";
import type {
  Suggestion,
  SuggestionCandidate,
  SuggestionConviction,
  SuggestionGroundingDebug,
  SuggestionMeta,
  SuggestionPipelineDebug,
  SuggestionsRequest,
} from "@/lib/types";

const CANDIDATE_BUDGET_THRESHOLD_MS = 14_000;
const NEAR_DUP_JACCARD_THRESHOLD = 0.72;

const isAbortLikeError = (error: unknown, abortSignal?: AbortSignal) =>
  abortSignal?.aborted === true ||
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError") ||
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ECONNRESET");

const normalizeConviction = (value: unknown): SuggestionConviction =>
  value === "medium" || value === "high" ? value : "high";

type PipelineHandlers = {
  onGrounding: (grounding: SuggestionGroundingDebug) => void;
  onMeta: (meta: {
    batch_id: string;
    generated_at: string;
    meeting_type: string;
    conversation_stage: string;
  }) => void;
  onCritiqueStarting: (candidateCount: number) => void;
  onCard: (suggestion: Suggestion, index: number, options?: { replace?: boolean }) => void;
  onRetrying: (reason: string) => void;
  onDebug: (debug: SuggestionPipelineDebug) => void;
  onDone: (summary: {
    batch_id: string;
    total_cards: number;
    critique_used: boolean;
    retry_fired: boolean;
    meta: SuggestionMeta;
  }) => void;
  onError: (message: string, code: string) => void;
};

type PipelineOptions = {
  signal?: AbortSignal;
  abortSignal?: AbortSignal;
  debug?: boolean;
};

export class PipelineAbortedError extends Error {
  constructor() {
    super("Suggestion pipeline aborted.");
    this.name = "PipelineAbortedError";
  }
}

const hydrateSuggestionSources = (
  suggestions: Suggestion[],
  groundedFacts: GroundedFact[],
): Suggestion[] => {
  if (groundedFacts.length === 0) {
    return suggestions;
  }

  const factsByUrl = new Map(
    groundedFacts.map((fact) => [fact.url, fact] as const),
  );

  return suggestions.map((suggestion) => {
    if (!suggestion.source_url) {
      return suggestion;
    }

    const matchingFact = factsByUrl.get(suggestion.source_url);

    if (!matchingFact) {
      return suggestion;
    }

    return {
      ...suggestion,
      source_title: matchingFact.title,
      source_scope: matchingFact.scope,
    };
  });
};

// ---------------------------------------------------------------------------
// JSON schemas
// ---------------------------------------------------------------------------

const candidatesResponseSchema = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        meeting_type: { type: "string" },
        conversation_stage: { type: "string" },
      },
      required: ["meeting_type", "conversation_stage"],
      additionalProperties: false,
    },
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...SUGGESTION_TYPES] },
          conviction: { type: "string", enum: ["high", "medium"] },
          preview: { type: "string" },
          full_content: { type: "string" },
          evidence_quote: { type: "string", minLength: 1, maxLength: 120 },
          rationale: { type: "string", minLength: 1, maxLength: 240 },
          source_url: { type: "string" },
        },
        required: ["type", "preview", "full_content", "evidence_quote", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["meta", "candidates"],
  additionalProperties: false,
} as const;

const critiqueResponseSchema = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        meeting_type: { type: "string" },
        conversation_stage: { type: "string" },
      },
      required: ["meeting_type", "conversation_stage"],
      additionalProperties: false,
    },
    selected: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...SUGGESTION_TYPES] },
          conviction: { type: "string", enum: ["high", "medium"] },
          preview: { type: "string" },
          full_content: { type: "string" },
          evidence_quote: { type: "string", minLength: 1, maxLength: 120 },
          rationale: { type: "string", minLength: 1, maxLength: 240 },
          why_relevant: { type: "string", minLength: 10, maxLength: 150 },
          source_url: { type: "string" },
          trigger: { type: "string" },
          selection_reason: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: [
          "type",
          "preview",
          "full_content",
          "evidence_quote",
          "rationale",
          "why_relevant",
          "trigger",
          "selection_reason",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["meta", "selected"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Diversity guards
// ---------------------------------------------------------------------------

const tokenize = (value: string): Set<string> => {
  const tokens = new Set<string>();
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  normalized.forEach((token) => tokens.add(token));
  return tokens;
};

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection += 1;
  });
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const evaluateDiversity = (
  suggestions: Suggestion[],
): { ok: true } | { ok: false; reason: string } => {
  if (suggestions.length !== 3) {
    return { ok: false, reason: "Expected exactly 3 selections." };
  }

  const types = new Set(suggestions.map((s) => s.type));
  if (types.size < 2) {
    return { ok: false, reason: "Selections collapsed to a single type." };
  }

  const factCheckCount = suggestions.filter((s) => s.type === "fact_check").length;
  if (factCheckCount > 1) {
    return { ok: false, reason: "More than one fact_check in the batch." };
  }

  const previewTokens = suggestions.map((s) => tokenize(s.preview));
  for (let i = 0; i < previewTokens.length; i += 1) {
    for (let j = i + 1; j < previewTokens.length; j += 1) {
      if (jaccard(previewTokens[i], previewTokens[j]) >= NEAR_DUP_JACCARD_THRESHOLD) {
        return { ok: false, reason: "Two selected previews are near-duplicates." };
      }
    }
  }

  return { ok: true };
};

// ---------------------------------------------------------------------------
// Call A: candidate generation (non-streaming)
// ---------------------------------------------------------------------------

type CandidatesResult = {
  candidates: SuggestionCandidate[];
  meta: SuggestionMeta;
};

const coerceCandidate = (raw: unknown): SuggestionCandidate | null => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isValidSuggestionType(record.type)) return null;
  if (
    typeof record.preview !== "string" ||
    typeof record.full_content !== "string" ||
    typeof record.evidence_quote !== "string" ||
    typeof record.rationale !== "string"
  ) {
    return null;
  }

  return {
    type: record.type,
    conviction: normalizeConviction(record.conviction),
    preview: record.preview.trim(),
    full_content: record.full_content.trim(),
    evidence_quote: record.evidence_quote.trim(),
    rationale: record.rationale.trim(),
    source_url: typeof record.source_url === "string" ? record.source_url.trim() || undefined : undefined,
  } satisfies SuggestionCandidate;
};

const runCandidateGeneration = async (
  apiKey: string,
  payload: SuggestionsRequest,
  salientMemoryRendered: string | undefined,
  groundedFacts: GroundedFact[],
  abortSignal: AbortSignal | undefined,
): Promise<CandidatesResult> => {
  const client = getLargeModelClient(apiKey);
  const { prompt } = buildCandidatesPrompt({
    contextWindow: DEFAULT_CONTEXT_WINDOWS.suggestions,
    fullTranscript: payload.full_transcript,
    verbatimRecent: payload.verbatim_recent,
    rollingSummary: payload.rolling_summary,
    recentChatTopics: payload.recent_chat_topics,
    avoidPhrases: payload.avoid_phrases,
    transcriptChunk: payload.transcript_chunk,
    meetingType: payload.meeting_type,
    conversationStage: payload.conversation_stage,
    salientMemoryRendered,
    groundedFacts,
  });

  const systemMessage = {
    role: "system" as const,
    content:
      "You are TwinMind, a real-time meeting copilot. Generate diverse candidate suggestions grounded strictly in the transcript. Never fabricate facts, numbers, names, or commitments.",
  };

  const maxTokens = isLargeModelExpandedContext() ? 12000 : 4000;

  const completion = await client.chat.completions.create(
    {
      model: getLargeModelName(),
      messages: [systemMessage, { role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "meeting_suggestion_candidates",
          strict: true,
          schema: candidatesResponseSchema,
        },
      },
      temperature: 0.65,
      top_p: 0.9,
      max_tokens: maxTokens,
      stream: false,
      stop: null,
    },
    {
      timeout: getSuggestionsTimeoutMs(),
      maxRetries: 0,
      signal: abortSignal,
    },
  );

  const rawText = extractAssistantText(completion.choices[0]?.message);
  if (!rawText) {
    throw new SuggestionGenerationError("Candidate generation returned no content.");
  }

  // --- Incremental candidate extraction (truncation-resilient) ---
  // Try full JSON.parse first for well-formed responses. If that fails
  // (truncation, malformed closing), fall back to the incremental array
  // extractor which recovers every completed candidate element.
  let rawCandidates: unknown[] = [];
  let metaBlock: { meeting_type?: string; conversation_stage?: string } | null = null;
  let wasTruncated = false;

  try {
    const parsed = JSON.parse(extractJsonObject(rawText)) as {
      meta?: { meeting_type?: string; conversation_stage?: string };
      candidates?: unknown[];
    };
    rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    metaBlock = parsed.meta ?? null;
  } catch {
    // JSON.parse failed — response was likely truncated.
    wasTruncated = true;
    rawCandidates = extractCompletedArrayElements(rawText, "candidates");
    metaBlock = extractMetaBlock(rawText);

    if (rawCandidates.length > 0) {
      console.info(
        `[pipeline] call A truncated; recovered ${rawCandidates.length} of intended 6 candidates`,
      );
    }
  }

  const coerced = rawCandidates
    .map((raw) => coerceCandidate(raw))
    .filter((candidate): candidate is SuggestionCandidate => candidate !== null);

  if (coerced.length < 3) {
    throw new SuggestionGenerationError(
      `Candidate generation returned fewer than 3 usable candidates${wasTruncated ? " (response was truncated)" : ""}.`,
    );
  }

  return {
    candidates: coerced,
    meta: {
      meeting_type:
        metaBlock?.meeting_type?.trim() || payload.meeting_type || "unspecified",
      conversation_stage:
        metaBlock?.conversation_stage?.trim() ||
        payload.conversation_stage ||
        "unspecified",
    },
  };
};

// ---------------------------------------------------------------------------
// Call B: critique + streaming selection
// ---------------------------------------------------------------------------

type StreamedSelection = {
  suggestion: Suggestion;
  index: number;
};

const runCritiqueStream = async (
  apiKey: string,
  params: {
    candidates: SuggestionCandidate[];
    meetingType?: string;
    conversationStage?: string;
    avoidPhrases?: string[];
    correctiveFeedback?: string;
    verbatimRecent?: string;
    groundedFacts: GroundedFact[];
    allowedUrls: Set<string>;
    groundedFactsByUrl: Map<string, { entity: string; fact: string; scope: string }>;
    onIncrementalCard: (selection: StreamedSelection) => void;
    abortSignal?: AbortSignal;
  },
): Promise<{ suggestions: Suggestion[]; meta: SuggestionMeta }> => {
  const client = getLargeModelClient(apiKey);
  const { prompt } = buildCritiquePrompt({
    candidates: params.candidates,
    meetingType: params.meetingType,
    conversationStage: params.conversationStage,
    avoidPhrases: params.avoidPhrases,
    correctiveFeedback: params.correctiveFeedback,
    groundedFacts: params.groundedFacts,
  });

  const systemMessage = {
    role: "system" as const,
    content:
      "You are the critic in a two-stage meeting copilot. Pick the strongest 3 candidates with enforced diversity. Preserve each candidate's evidence_quote verbatim. Never invent new facts.",
  };

  // Critique output: 3 Suggestions * (~140w full_content + ~30w selection_reason) ≈
  // 1.8k tokens of JSON. Compact enough that 1500 suffices for both paths.
  const maxTokens = 1500;

  const completion = await client.chat.completions.create(
    {
      model: getLargeModelName(),
      messages: [systemMessage, { role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "meeting_suggestions_critique",
          strict: true,
          schema: critiqueResponseSchema,
        },
      },
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: maxTokens,
      stream: true,
      stop: null,
    },
    {
      timeout: getSuggestionsTimeoutMs(),
      maxRetries: 0,
      signal: params.abortSignal,
    },
  );

  const parser = new SuggestionsStreamParser("selected");
  let assembled = "";
  let reasoningFallback = "";
  const emittedIndexes = new Set<number>();

  for await (const chunk of completion) {
    if (params.abortSignal?.aborted) break;

    const delta = chunk.choices[0]?.delta as
      | { content?: string | null; reasoning_content?: string | null }
      | undefined;
    const token = delta?.content ?? "";
    const reasoningToken = delta?.reasoning_content ?? "";

    if (reasoningToken) reasoningFallback += reasoningToken;
    if (!token) continue;

    assembled += token;
    const { completedElements } = parser.append(token);

    for (const { raw, index } of completedElements) {
      const card = coerceStreamedCard(raw, index);
      if (card && !emittedIndexes.has(index)) {
        emittedIndexes.add(index);
        params.onIncrementalCard({ suggestion: card, index });
      }
    }
  }

  const source = assembled.trim() ? assembled : reasoningFallback.trim();
  if (!source) {
    throw new SuggestionGenerationError("Critique stream returned no content.");
  }

  // Call B output is small (~300 tokens), so full JSON.parse is fine.
  // Wrap in try/catch so truncated critique falls through to the caller's
  // fallback path (emit raw Call A top-3).
  let parsedContent: {
    meta?: { meeting_type?: string; conversation_stage?: string };
    selected?: Array<Omit<Suggestion, "id">>;
  };

  try {
    const rawJson = extractJsonObject(source);
    parsedContent = JSON.parse(rawJson) as typeof parsedContent;
  } catch {
    console.warn("[pipeline] call B JSON invalid, emitting raw top-3");
    throw new SuggestionGenerationError("Critique JSON was malformed or truncated.");
  }

  const selectedArray = Array.isArray(parsedContent.selected) ? parsedContent.selected : [];
  if (selectedArray.length !== 3) {
    throw new SuggestionGenerationError(
      `Critique returned ${selectedArray.length} selections; expected 3.`,
    );
  }

  const normalized = selectedArray.map((entry, index) => normalizeSuggestion(entry, index));
  const validated = validateSuggestions(
    normalized,
    params.verbatimRecent,
    params.allowedUrls,
    params.groundedFactsByUrl,
  );

  return {
    suggestions: hydrateSuggestionSources(validated, params.groundedFacts),
    meta: {
      meeting_type: parsedContent.meta?.meeting_type?.trim() || params.meetingType || "unspecified",
      conversation_stage:
        parsedContent.meta?.conversation_stage?.trim() ||
        params.conversationStage ||
        "unspecified",
    },
  };
};

// ---------------------------------------------------------------------------
// Fallback: emit raw call-A candidates as Suggestion cards
// ---------------------------------------------------------------------------

const projectCandidatesToSuggestions = (candidates: SuggestionCandidate[]): Suggestion[] =>
  candidates.slice(0, 3).map((candidate, index) =>
    normalizeSuggestion(
      {
        type: candidate.type,
        conviction: normalizeConviction(candidate.conviction),
        preview: candidate.preview,
        full_content: candidate.full_content,
        evidence_quote: candidate.evidence_quote,
        rationale: candidate.rationale,
        source_url: candidate.source_url,
        why_relevant: candidate.rationale.slice(0, 150),
        trigger: candidate.rationale,
      },
      index,
    ),
  );

const emitFallbackCards = (
  candidates: SuggestionCandidate[],
  verbatimRecent: string | undefined,
  allowedUrls: Set<string>,
  groundedFactsByUrl: Map<string, { entity: string; fact: string; scope: string }>,
  groundedFacts: GroundedFact[],
  handlers: PipelineHandlers,
  { replace }: { replace: boolean },
): Suggestion[] => {
  let suggestions: Suggestion[] = [];

  try {
    suggestions = hydrateSuggestionSources(
      validateSuggestions(
        projectCandidatesToSuggestions(candidates),
        verbatimRecent,
        allowedUrls,
        groundedFactsByUrl,
      ),
      groundedFacts,
    );
  } catch (error) {
    console.warn("[suggestions][pipeline] fallback emission failed, skipping fallback", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  suggestions.forEach((suggestion, index) => {
    handlers.onCard(suggestion, index, replace ? { replace: true } : undefined);
  });
  return suggestions;
};

// ---------------------------------------------------------------------------
// Error classification (mirrors generateSuggestionsStreaming)
// ---------------------------------------------------------------------------

const mapErrorToFrame = (error: unknown): { message: string; code: string } => {
  if (error instanceof SuggestionGenerationError) {
    return { message: error.message, code: "validation_failed" };
  }
  if (error instanceof SyntaxError) {
    return { message: "Failed to parse suggestions from model output.", code: "parse_failed" };
  }
  if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
    const status = (error as { status?: number }).status;
    if (status === 401) return { message: "Invalid API key", code: "invalid_key" };
    if (status === 429) return { message: "Rate limit hit", code: "rate_limited" };
    if (status === 408 || error.name === "APITimeoutError") {
      return { message: "Request timeout", code: "timeout" };
    }
    return { message: error.message || "Upstream provider error.", code: "provider_error" };
  }
  if (error instanceof Groq.APIConnectionTimeoutError) {
    return { message: "Suggestion generation timed out.", code: "timeout" };
  }
  if (error instanceof Error) {
    return { message: error.message || "Failed to generate suggestions.", code: "unknown" };
  }
  return { message: "Failed to generate suggestions.", code: "unknown" };
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const generateSuggestionsPipeline = async (
  apiKey: string,
  payload: SuggestionsRequest,
  salientMemoryRendered: string | undefined,
  handlers: PipelineHandlers,
  options: PipelineOptions = {},
): Promise<void> => {
  const abortSignal = options.signal ?? options.abortSignal;
  const { debug } = options;

  try {
    const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const generatedAt = new Date().toISOString();

    let candidates: SuggestionCandidate[] = [];
    let preliminaryMeta: SuggestionMeta = {
      meeting_type: payload.meeting_type || "unspecified",
      conversation_stage: payload.conversation_stage || "unspecified",
    };
    let callAms: number | undefined;
    let callBms: number | undefined;

    const startA = Date.now();
    let groundingResult;
    try {
      groundingResult = await fetchGroundingFor(
        apiKey,
        payload.verbatim_recent || payload.transcript_chunk || payload.full_transcript,
        payload.session_id || "default",
        abortSignal,
      );
    } catch (error) {
      if (isAbortLikeError(error, abortSignal)) {
        throw error;
      }
      console.warn("[grounding] fetch failed; continuing without grounded facts", {
        message: error instanceof Error ? error.message : String(error),
        session_id: payload.session_id || "default",
      });
      groundingResult = {
        facts: [],
        entities: [],
        searches_used: 0,
        searches_remaining: 0,
        cache_hits: 0,
        entities_found: 0,
        skipped_reason: "no_entities" as const,
      };
    }
    const allowedUrls = new Set(groundingResult.facts.map((fact) => fact.url));
    const groundedFactsByUrl = new Map(
      groundingResult.facts.map((fact) => [
        fact.url,
        { entity: fact.entity, fact: fact.fact, scope: fact.scope },
      ]),
    );
    const groundingDebug: SuggestionGroundingDebug = {
      entities_found: groundingResult.entities_found ?? 0,
      entities: groundingResult.entities,
      searches_used: groundingResult.searches_used,
      searches_remaining: groundingResult.searches_remaining,
      cache_hits: groundingResult.cache_hits,
      facts_count: groundingResult.facts.length,
      skipped_reason: groundingResult.skipped_reason,
    };
    handlers.onGrounding(groundingDebug);

    try {
      const result = await runCandidateGeneration(
        apiKey,
        payload,
        salientMemoryRendered,
        groundingResult.facts,
        abortSignal,
      );
      callAms = Date.now() - startA;
      candidates = result.candidates;
      preliminaryMeta = result.meta;
    } catch (error) {
      if (isAbortLikeError(error, abortSignal)) {
        throw error;
      }
      const frame = mapErrorToFrame(error);
      console.error("[suggestions] pipeline error", {
        batch_id: batchId,
        error: error instanceof Error ? error.message : String(error),
        code: frame.code,
        stage: "call_a",
      });
      handlers.onError(frame.message, frame.code);
      return;
    }

    handlers.onMeta({
      batch_id: batchId,
      generated_at: generatedAt,
      meeting_type: preliminaryMeta.meeting_type,
      conversation_stage: preliminaryMeta.conversation_stage,
    });

    const budgetExhausted = callAms !== undefined && callAms > CANDIDATE_BUDGET_THRESHOLD_MS;

    // Graceful degradation: skip critique, emit raw candidates.
    if (budgetExhausted) {
      console.info("[suggestions] critique skipped: budget exhausted", {
        call_a_ms: callAms,
        threshold_ms: CANDIDATE_BUDGET_THRESHOLD_MS,
      });
      const finals = emitFallbackCards(
        candidates,
        payload.verbatim_recent,
        allowedUrls,
        groundedFactsByUrl,
        groundingResult.facts,
        handlers,
        { replace: false },
      );
      if (debug) {
        handlers.onDebug({
          candidates,
          selections: finals,
          fell_back_to_raw: true,
          critique_skipped_budget: true,
          retry_fired: false,
          call_a_ms: callAms,
          grounding: groundingDebug,
        });
      }
      handlers.onDone({
        batch_id: batchId,
        total_cards: finals.length,
        critique_used: false,
        retry_fired: false,
        meta: {
          ...preliminaryMeta,
          grounding: {
            searches_used: groundingDebug.searches_used,
            searches_remaining: groundingDebug.searches_remaining,
            facts_count: groundingDebug.facts_count,
            ...(groundingDebug.skipped_reason
              ? { skipped_reason: groundingDebug.skipped_reason }
              : {}),
          },
        },
      });
      return;
    }

    handlers.onCritiqueStarting(candidates.length);

    const avoidPhrasesForCritique = payload.avoid_phrases;
    let critiqueMeta: SuggestionMeta = preliminaryMeta;
    let critiqueSelections: Suggestion[] = [];
    let retryFired = false;
    let fallbackFired = false;

    const runCritiqueOnce = async (
      correctiveFeedback: string | undefined,
      replacing: boolean,
    ): Promise<{ suggestions: Suggestion[]; meta: SuggestionMeta }> => {
      const streamedByIndex = new Map<number, Suggestion>();
      const startB = Date.now();
      try {
        const result = await runCritiqueStream(apiKey, {
          candidates,
          meetingType: preliminaryMeta.meeting_type,
          conversationStage: preliminaryMeta.conversation_stage,
          avoidPhrases: avoidPhrasesForCritique,
          correctiveFeedback,
          verbatimRecent: payload.verbatim_recent,
          groundedFacts: groundingResult.facts,
          allowedUrls,
          groundedFactsByUrl,
          abortSignal,
          onIncrementalCard: ({ suggestion, index }) => {
            streamedByIndex.set(index, suggestion);
            handlers.onCard(suggestion, index, replacing ? { replace: true } : undefined);
          },
        });
        callBms = Date.now() - startB;
        return result;
      } finally {
        critiqueSelections = Array.from(streamedByIndex.values());
      }
    };

    try {
      const critiqueResult = await runCritiqueOnce(undefined, false);
      critiqueSelections = critiqueResult.suggestions;
      critiqueMeta = critiqueResult.meta;

      const diversity = evaluateDiversity(critiqueSelections);
      if (!diversity.ok) {
        console.warn("[suggestions] critique diversity violation — retrying once", {
          reason: diversity.reason,
        });
        handlers.onRetrying(`critique-diversity: ${diversity.reason}`);
        retryFired = true;

        const strippedForCorrective = critiqueSelections.map((suggestion) => {
          const { id, ...rest } = suggestion;
          void id;
          return rest;
        });
        const corrective = `Your previous selection violated the diversity rules (${diversity.reason}). Here is the failed output you returned; do not repeat it:\n${JSON.stringify(
          strippedForCorrective,
          null,
          2,
        )}\nRe-select 3 candidates that satisfy: >=2 distinct types, <=1 fact_check, no near-duplicate previews.`;

        const retryResult = await runCritiqueOnce(corrective, true);
        critiqueSelections = retryResult.suggestions;
        critiqueMeta = retryResult.meta;

        const retryDiversity = evaluateDiversity(critiqueSelections);
        if (!retryDiversity.ok) {
          console.warn(
            "[suggestions] critique retry still violated diversity — falling back to raw candidates",
            { reason: retryDiversity.reason },
          );
          fallbackFired = true;
          critiqueSelections = emitFallbackCards(
            candidates,
            payload.verbatim_recent,
            allowedUrls,
            groundedFactsByUrl,
            groundingResult.facts,
            handlers,
            { replace: true },
          );
        }
      }
  } catch (error) {
    if (isAbortLikeError(error, abortSignal)) {
      throw error;
    }
    console.error("[suggestions] pipeline error", {
        batch_id: batchId,
        error: error instanceof Error ? error.message : String(error),
        code: "critique_failed",
        stage: "call_b",
    });
    fallbackFired = true;
    try {
      critiqueSelections = emitFallbackCards(
        candidates,
        payload.verbatim_recent,
        allowedUrls,
        groundedFactsByUrl,
        groundingResult.facts,
        handlers,
        {
          replace: critiqueSelections.length > 0,
        },
      );
    } catch (fallbackError) {
      console.warn("[suggestions][pipeline] fallback emission failed, skipping fallback", {
        reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      critiqueSelections = [];
    }
  }

    if (debug) {
      handlers.onDebug({
        candidates,
        selections: critiqueSelections,
        fell_back_to_raw: fallbackFired,
        critique_skipped_budget: false,
        retry_fired: retryFired,
        call_a_ms: callAms,
        call_b_ms: callBms,
        grounding: groundingDebug,
      });
    }

    handlers.onDone({
      batch_id: batchId,
      total_cards: critiqueSelections.length,
      critique_used: !fallbackFired,
      retry_fired: retryFired,
      meta: {
        ...critiqueMeta,
        grounding: {
          searches_used: groundingDebug.searches_used,
          searches_remaining: groundingDebug.searches_remaining,
          facts_count: groundingDebug.facts_count,
          ...(groundingDebug.skipped_reason
            ? { skipped_reason: groundingDebug.skipped_reason }
            : {}),
        },
      },
    });
  } catch (error) {
    if (error instanceof PipelineAbortedError) {
      throw error;
    }
    if (isAbortLikeError(error, abortSignal)) {
      throw new PipelineAbortedError();
    }
    throw error;
  }
};
