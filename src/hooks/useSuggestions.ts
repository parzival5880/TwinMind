"use client";

import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
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
};

type GenerateSuggestionsContext = {
  rollingSummary?: string;
  recentChatTopics?: string;
};

type UseSuggestionsResult = {
  clearSuggestions: () => void;
  error: string | null;
  generateSuggestions: (
    transcript: TranscriptChunk[],
    context?: GenerateSuggestionsContext,
  ) => Promise<SuggestionBatch | null>;
  isLoading: boolean;
  suggestions: SuggestionBatch[];
};

const buildTranscriptString = (transcript: TranscriptChunk[]) =>
  transcript
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";

      return `[${chunk.timestamp.toISOString()}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

const VERBATIM_WINDOW_MS = 90_000;

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

  return buildTranscriptString(chunksToUse);
};

const flattenPreviousSuggestions = (batches: SuggestionBatch[]) =>
  batches.flatMap((batch) => batch.suggestions);

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
  previousBatches: SuggestionBatch[];
  rollingSummary?: string;
  recentChatTopics?: string;
  avoidPhrases?: string[];
  contextWindow?: number;
  groqApiKey?: string;
  promptTemplate?: string;
};

const fetchSuggestions = async ({
  transcript,
  previousBatches,
  rollingSummary,
  recentChatTopics,
  avoidPhrases,
  contextWindow,
  groqApiKey,
  promptTemplate,
}: FetchSuggestionsArgs): Promise<SuggestionsResponse> => {
  const response = await fetch("/api/suggestions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(groqApiKey ? { "x-groq-api-key": groqApiKey } : {}),
    },
    body: JSON.stringify({
      transcript_chunk: transcript.at(-1)?.text ?? "",
      full_transcript: buildTranscriptString(transcript),
      verbatim_recent: buildVerbatimRecent(transcript),
      rolling_summary: rollingSummary,
      recent_chat_topics: recentChatTopics,
      avoid_phrases: avoidPhrases,
      previous_suggestions: flattenPreviousSuggestions(previousBatches),
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
}: UseSuggestionsOptions = {}): UseSuggestionsResult {
  const [suggestions, setSuggestions] = useState<SuggestionBatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateSuggestions = async (
    transcript: TranscriptChunk[],
    context: GenerateSuggestionsContext = {},
  ) => {
    if (transcript.length === 0 || isLoading) {
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const previousBatches = suggestions;

      // First pass: generate with the normal context payload.
      let payload = await fetchSuggestions({
        transcript,
        previousBatches,
        rollingSummary: context.rollingSummary,
        recentChatTopics: context.recentChatTopics,
        contextWindow,
        groqApiKey,
        promptTemplate,
      });

      // Dedup guard: if any preview is too similar to a recent-batch preview,
      // retry ONCE with those phrasings explicitly marked as "avoid".
      const duplicatePhrases = findNearDuplicatePreviews(payload.suggestions, previousBatches);

      if (duplicatePhrases.length > 0) {
        try {
          payload = await fetchSuggestions({
            transcript,
            previousBatches,
            rollingSummary: context.rollingSummary,
            recentChatTopics: context.recentChatTopics,
            avoidPhrases: duplicatePhrases,
            contextWindow,
            groqApiKey,
            promptTemplate,
          });
        } catch {
          // Swallow the retry failure; fall back to the first-pass result so
          // the user still sees suggestions even if the dedup retry fails.
        }
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

      setSuggestions((currentSuggestions) => [batch, ...currentSuggestions]);

      return batch;
    } catch {
      setError("Failed to generate suggestions. Check API key.");

      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const clearSuggestions = () => {
    setSuggestions([]);
    setError(null);
  };

  return {
    clearSuggestions,
    error,
    generateSuggestions,
    isLoading,
    suggestions,
  };
}
