"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { startTelemetryMeasurement } from "@/lib/telemetry";
import type {
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
  rollingSummary?: string;
  recentChatTopics?: string;
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

const VERBATIM_WINDOW_MS = 90_000;
const VERBATIM_MAX_CHARS = 1600;

// The "verbatim recent" block is the primary signal passed to the model. It
// captures only the last 90 seconds of transcript, measured relative to the
// newest chunk's timestamp. Older context flows through rolling_summary.
const buildVerbatimRecent = (transcript: TranscriptChunk[]) => {
  if (transcript.length === 0) {
    return "";
  }

  const newest = transcript[transcript.length - 1];
  const cutoffTime = newest.timestamp.getTime() - VERBATIM_WINDOW_MS;
  const recent = transcript.filter((chunk) => chunk.timestamp.getTime() >= cutoffTime);
  const chunksToUse = recent.length > 0 ? recent : transcript.slice(-3);

  let verbatim = buildTranscriptString(chunksToUse);

  // Strip filler tokens — standalone interjections and common verbal crutches.
  verbatim = verbatim.replace(/\b(um|uh|uhh|erm|hmm)\b[,.\s]?/gi, " ");
  verbatim = verbatim.replace(/\b(you know|i mean|kind of|sort of)\b/gi, "");
  // Collapse any resulting double/triple spaces.
  verbatim = verbatim.replace(/ {2,}/g, " ").trim();

  // Hard-cap at VERBATIM_MAX_CHARS, keeping the most recent content.
  if (verbatim.length > VERBATIM_MAX_CHARS) {
    verbatim = "\u2026" + verbatim.slice(-VERBATIM_MAX_CHARS);
  }

  return verbatim;
};


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

const SIMILARITY_THRESHOLD = 0.7;
const RECENT_BATCHES_FOR_DEDUP = 2;

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
  rollingSummary?: string;
  recentChatTopics?: string;
  avoidPhrases?: string[];
  contextWindow?: number;
  groqApiKey?: string;
  promptTemplate?: string;
  signal?: AbortSignal;
};

const fetchSuggestions = async ({
  transcript,
  rollingSummary,
  recentChatTopics,
  avoidPhrases,
  contextWindow,
  groqApiKey,
  promptTemplate,
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
    }),
  });

  const payload = (await response.json()) as SuggestionsResponse;

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || "Failed to generate suggestions. Check API key.");
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
  const lastVerbatimRef = useRef<string>("");
  const backoffUntilRef = useRef<number>(0);
  const consecutiveRateLimitRef = useRef<number>(0);

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
      if (transcript.length === 0) {
        return null;
      }

      // 429 backoff gate — applies to all sources.
      if (Date.now() < backoffUntilRef.current) {
        return null;
      }

      const isAutoSource = options?.source === "auto";

      // Silence gate + change-delta gate — only for auto triggers.
      if (isAutoSource) {
        if (pauseWhileChatInflight()) {
          return null;
        }

        const newVerbatim = buildVerbatimRecent(transcript);
        const newTokens = tokenize(newVerbatim);
        const oldTokens = tokenize(lastVerbatimRef.current);
        const growth = newTokens.size - oldTokens.size;

        // Gate 1: fewer than 15 meaningful words of growth → skip.
        if (growth < 15) {
          return null;
        }

        // Gate 2: high similarity AND fewer than 30 words of growth → skip.
        if (jaccard(newTokens, oldTokens) > 0.8 && growth < 30) {
          return null;
        }
      }

      if (isLoadingRef.current && !options?.replacePending) {
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

      try {
        const previousBatches = suggestionsRef.current;

        let payload = await fetchSuggestions({
          transcript,
          rollingSummary: context.rollingSummary,
          recentChatTopics: context.recentChatTopics,
          contextWindow,
          groqApiKey,
          promptTemplate,
          signal: abortController.signal,
        });

        const duplicatePhrases = findNearDuplicatePreviews(payload.suggestions, previousBatches);

        if (duplicatePhrases.length > 0) {
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
              contextWindow,
              groqApiKey,
              promptTemplate,
              signal: retryController.signal,
            });
          } catch {
            // Keep the first-pass result if the dedup retry fails.
          } finally {
            window.clearTimeout(retryTimeoutId);
          }
        }

        if (requestId !== requestSequenceRef.current) {
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

        // Success — update verbatim ref and reset rate-limit counter.
        lastVerbatimRef.current = buildVerbatimRecent(transcript);
        consecutiveRateLimitRef.current = 0;

        return batch;
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === "AbortError") {
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
