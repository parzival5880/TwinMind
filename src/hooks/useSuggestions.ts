"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { startTelemetryMeasurement } from "@/lib/telemetry";
import { buildVerbatimRecent } from "@/lib/verbatim";
import type {
  RollingSummary,
  SalientMoment,
  Suggestion,
  SuggestionBatch,
  SuggestionsResponse,
  TranscriptChunk,
} from "@/lib/types";

type UseSuggestionsOptions = {
  contextWindow?: number;
  groqApiKey?: string;
  promptTemplate?: string;
  pauseWhileChatInflight?: () => boolean;
};

type GenerateSuggestionsContext = {
  rollingSummary?: RollingSummary | null;
  recentChatTopics?: string;
  salientMemory?: SalientMoment[];
  meetingType?: string;
  conversationStage?: string;
};

type UseSuggestionsResult = {
  cancelSuggestions: () => void;
  clearSuggestions: () => void;
  error: string | null;
  generateSuggestions: (
    transcript: TranscriptChunk[],
    context?: GenerateSuggestionsContext,
    options?: {
      replacePending?: boolean;
      source?: "auto" | "manual";
    },
  ) => Promise<SuggestionBatch | null>;
  isLoading: boolean;
  suggestions: SuggestionBatch[];
};

const SUGGESTIONS_FETCH_TIMEOUT_MS = 8_000;

const buildTranscriptString = (transcript: TranscriptChunk[]) =>
  transcript
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";

      return `[${chunk.timestamp.toISOString()}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

// Tokenize a preview into a set of meaningful tokens (letters/digits only,
// stopwords removed). Jaccard on this set approximates near-duplicate risk.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "about",
  "from",
  "into",
  "if",
  "then",
  "so",
  "than",
  "too",
  "very",
  "not",
  "no",
  "you",
  "your",
  "their",
  "them",
  "they",
  "we",
  "our",
  "us",
]);

const tokenize = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }

  let intersectionCount = 0;

  a.forEach((token) => {
    if (b.has(token)) {
      intersectionCount += 1;
    }
  });

  const unionCount = a.size + b.size - intersectionCount;

  if (unionCount === 0) {
    return 0;
  }

  return intersectionCount / unionCount;
};

// 0.85 = only retry when suggestions are near-identical to a prior batch.
// 0.7 was too aggressive and doubled 120B TPM too often.
const SIMILARITY_THRESHOLD = 0.85;
const RECENT_BATCHES_FOR_DEDUP = 2;
const RETRY_COOLDOWN_MS = 90_000;
const SHOULD_DEBUG_SUGGESTIONS = process.env.NODE_ENV !== "production";

// Returns the list of previous-suggestion previews that are too similar to
// any of the newly generated previews. If non-empty, we should retry once
// with these phrasings marked as "avoid".
const findNearDuplicatePreviews = (
  newSuggestions: Suggestion[],
  previousBatches: SuggestionBatch[],
) => {
  const recentPreviousPreviews = previousBatches
    .slice(0, RECENT_BATCHES_FOR_DEDUP)
    .flatMap((batch) => batch.suggestions.map((suggestion) => suggestion.preview));

  if (recentPreviousPreviews.length === 0) {
    return [] as string[];
  }

  const previousTokenSets = recentPreviousPreviews.map((preview) => ({
    preview,
    tokens: tokenize(preview),
  }));

  const duplicatePreviews = new Set<string>();

  newSuggestions.forEach((suggestion) => {
    const newTokens = tokenize(suggestion.preview);

    previousTokenSets.forEach(({ preview, tokens }) => {
      if (jaccard(newTokens, tokens) >= SIMILARITY_THRESHOLD) {
        duplicatePreviews.add(preview);
      }
    });
  });

  return Array.from(duplicatePreviews);
};

type FetchSuggestionsArgs = {
  transcript: TranscriptChunk[];
  rollingSummary?: RollingSummary | null;
  recentChatTopics?: string;
  avoidPhrases?: string[];
  salientMemory?: SalientMoment[];
  contextWindow?: number;
  groqApiKey?: string;
  promptTemplate?: string;
  meetingType?: string;
  conversationStage?: string;
  signal?: AbortSignal;
};

class SuggestionsRequestError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SuggestionsRequestError";
    this.status = status;
  }
}

const fetchSuggestions = async ({
  transcript,
  rollingSummary,
  recentChatTopics,
  avoidPhrases,
  salientMemory,
  contextWindow,
  groqApiKey,
  promptTemplate,
  meetingType,
  conversationStage,
  signal,
}: FetchSuggestionsArgs): Promise<SuggestionsResponse> => {
  const verbatimRecent = buildVerbatimRecent(transcript);
  const response = await fetch("/api/suggestions", {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(groqApiKey ? { "x-groq-api-key": groqApiKey } : {}),
    },
    body: JSON.stringify({
      transcript_chunk: transcript.at(-1)?.text ?? "",
      full_transcript: verbatimRecent ? "" : buildTranscriptString(transcript),
      verbatim_recent: verbatimRecent,
      rolling_summary: rollingSummary,
      recent_chat_topics: recentChatTopics,
      avoid_phrases: avoidPhrases,
      context_window: contextWindow,
      prompt_template: promptTemplate,
      meeting_type: meetingType,
      conversation_stage: conversationStage,
      ...(salientMemory && salientMemory.length > 0 ? { salient_memory: salientMemory } : {}),
    }),
  });

  const payload = (await response.json()) as SuggestionsResponse;

  if (!response.ok || !payload.success) {
    throw new SuggestionsRequestError(
      payload.error || "Failed to generate suggestions. Check API key.",
      response.status,
    );
  }

  return payload;
};

export function useSuggestions({
  contextWindow,
  groqApiKey,
  promptTemplate,
  pauseWhileChatInflight = () => false,
}: UseSuggestionsOptions = {}): UseSuggestionsResult {
  const [suggestions, setSuggestions] = useState<SuggestionBatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestionsRef = useRef<SuggestionBatch[]>([]);
  const isLoadingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  // Gating refs — all internal, nothing exposed.
  const lastMeetingTypeRef = useRef<string | undefined>(undefined);
  const lastConversationStageRef = useRef<string | undefined>(undefined);
  const lastVerbatimRef = useRef<string>("");
  const backoffUntilRef = useRef<number>(0);
  const consecutiveRateLimitRef = useRef<number>(0);
  const lastRetryAtRef = useRef<number>(0);

  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  const cancelSuggestions = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
  }, []);

  const generateSuggestions = useCallback(
    async (
      transcript: TranscriptChunk[],
      context: GenerateSuggestionsContext = {},
      options?: {
        replacePending?: boolean;
        source?: "auto" | "manual";
      },
    ) => {
      const logSkip = (reason: string, details?: Record<string, unknown>) => {
        if (!SHOULD_DEBUG_SUGGESTIONS) {
          return;
        }

        console.warn("[TwinMind][suggestions][client][skip]", {
          reason,
          source: options?.source ?? "manual",
          ...details,
        });
      };

      if (transcript.length === 0) {
        logSkip("empty-transcript");
        return null;
      }

      // 429 backoff gate — applies to all sources.
      if (Date.now() < backoffUntilRef.current) {
        logSkip("rate-limit-backoff", {
          backoff_remaining_ms: Math.max(0, backoffUntilRef.current - Date.now()),
        });
        return null;
      }

      const isAutoSource = options?.source === "auto";

      // Silence gate + change-delta gate — only for auto triggers.
      if (isAutoSource) {
        if (pauseWhileChatInflight()) {
          logSkip("chat-inflight");
          return null;
        }

        const newVerbatim = buildVerbatimRecent(transcript);
        const newTokens = tokenize(newVerbatim);
        const oldTokens = tokenize(lastVerbatimRef.current);
        const growth = newTokens.size - oldTokens.size;

        // Gate 1: fewer than 8 meaningful words of growth → skip.
        if (growth < 8) {
          logSkip("growth-below-threshold", {
            growth,
            threshold: 8,
            transcript_chunks: transcript.length,
          });
          return null;
        }

        // Gate 2: high similarity AND fewer than 15 words of growth → skip.
        const similarity = jaccard(newTokens, oldTokens);

        if (similarity > 0.8 && growth < 15) {
          logSkip("high-similarity-low-growth", {
            growth,
            similarity,
            threshold_growth: 15,
            threshold_similarity: 0.8,
          });
          return null;
        }
      }

      if (isLoadingRef.current && !options?.replacePending) {
        logSkip("request-already-in-flight");
        return null;
      }

      if (options?.replacePending) {
        abortControllerRef.current?.abort();
      }

      const requestId = requestSequenceRef.current + 1;
      const abortController = new AbortController();
      const abortTimeoutId = window.setTimeout(() => {
        abortController.abort();
      }, SUGGESTIONS_FETCH_TIMEOUT_MS);
      const completeTelemetry = startTelemetryMeasurement("suggestions_first_render", {
        source: options?.source ?? "manual",
      });

      requestSequenceRef.current = requestId;
      abortControllerRef.current = abortController;
      setIsLoading(true);
      setError(null);

      if (SHOULD_DEBUG_SUGGESTIONS) {
        console.warn("[TwinMind][suggestions][client][dispatch]", {
          context_window: contextWindow,
          request_id: requestId,
          source: options?.source ?? "manual",
          transcript_chunks: transcript.length,
          transcript_tail: transcript.at(-1)?.text ?? "",
        });
      }

      try {
        const previousBatches = suggestionsRef.current;

        let payload = await fetchSuggestions({
          transcript,
          rollingSummary: context.rollingSummary,
          recentChatTopics: context.recentChatTopics,
          salientMemory: context.salientMemory,
          contextWindow,
          groqApiKey,
          promptTemplate,
          meetingType: context.meetingType ?? lastMeetingTypeRef.current,
          conversationStage: context.conversationStage ?? lastConversationStageRef.current,
          signal: abortController.signal,
        });

        const firstPassPayload = payload;
        const duplicatePhrases = findNearDuplicatePreviews(payload.suggestions, previousBatches);

        if (duplicatePhrases.length > 0 && Date.now() - lastRetryAtRef.current >= RETRY_COOLDOWN_MS) {
          if (SHOULD_DEBUG_SUGGESTIONS) {
            console.warn("[TwinMind][suggestions][client][retry]", {
              duplicate_count: duplicatePhrases.length,
              request_id: requestId,
            });
          }
          lastRetryAtRef.current = Date.now();
          const retryController = new AbortController();
          const retryTimeoutId = window.setTimeout(() => {
            retryController.abort();
          }, 5_000);

          try {
            payload = await fetchSuggestions({
              transcript,
              rollingSummary: context.rollingSummary,
              recentChatTopics: context.recentChatTopics,
              avoidPhrases: duplicatePhrases,
              salientMemory: context.salientMemory,
              contextWindow,
              groqApiKey,
              promptTemplate,
              meetingType: context.meetingType ?? lastMeetingTypeRef.current,
              conversationStage: context.conversationStage ?? lastConversationStageRef.current,
              signal: retryController.signal,
            });
          } catch {
            // Keep the first-pass result if the dedup retry fails.
            payload = firstPassPayload;
          } finally {
            window.clearTimeout(retryTimeoutId);
          }
        }

        if (requestId !== requestSequenceRef.current) {
          logSkip("stale-request-result", { request_id: requestId });
          return null;
        }

        const batch: SuggestionBatch = {
          id: uuidv4(),
          suggestions: payload.suggestions.map((suggestion) => ({
            ...suggestion,
            id: uuidv4(),
          })),
          meta: payload.meta,
          timestamp: new Date(payload.timestamp),
        };

        startTransition(() => {
          setSuggestions((currentSuggestions) => [batch, ...currentSuggestions]);
        });
        window.requestAnimationFrame(() => {
          completeTelemetry({
            suggestion_count: batch.suggestions.length,
          });
        });

        // Success — update verbatim ref, meeting type, and reset rate-limit counter.
        lastMeetingTypeRef.current = payload.meta?.meeting_type;
        lastConversationStageRef.current = payload.meta?.conversation_stage;
        lastVerbatimRef.current = buildVerbatimRecent(transcript);
        consecutiveRateLimitRef.current = 0;

        if (SHOULD_DEBUG_SUGGESTIONS) {
          console.warn("[TwinMind][suggestions][client][success]", {
            request_id: requestId,
            suggestion_count: batch.suggestions.length,
          });
        }

        return batch;
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === "AbortError") {
          logSkip("request-aborted", { request_id: requestId });
          return null;
        }

        // 429 backoff handling.
        const errorMessage =
          caughtError instanceof Error ? caughtError.message : String(caughtError);
        const is429 =
          (caughtError as { status?: number })?.status === 429 ||
          errorMessage.toLowerCase().includes("rate limit");

        if (is429) {
          consecutiveRateLimitRef.current += 1;
          const backoffMs = consecutiveRateLimitRef.current >= 2 ? 120_000 : 60_000;
          backoffUntilRef.current = Date.now() + backoffMs;
          console.warn(
            `[TwinMind] Rate-limited. Backing off suggestions for ${backoffMs / 1000}s.`,
          );
        }

        if (SHOULD_DEBUG_SUGGESTIONS) {
          console.error("[TwinMind][suggestions][client][error]", {
            error_message: errorMessage,
            request_id: requestId,
            status: (caughtError as { status?: number })?.status,
          });
        }

        setError("Failed to generate suggestions. Check API key.");

        return null;
      } finally {
        window.clearTimeout(abortTimeoutId);

        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [contextWindow, groqApiKey, pauseWhileChatInflight, promptTemplate],
  );

  const clearSuggestions = useCallback(() => {
    cancelSuggestions();
    startTransition(() => {
      setSuggestions([]);
    });
    setError(null);
  }, [cancelSuggestions]);

  return {
    cancelSuggestions,
    clearSuggestions,
    error,
    generateSuggestions,
    isLoading,
    suggestions,
  };
}
