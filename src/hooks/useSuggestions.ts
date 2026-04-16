"use client";

import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  SuggestionBatch,
  SuggestionsResponse,
  TranscriptChunk,
} from "@/lib/types";

type UseSuggestionsOptions = {
  contextWindow?: number;
  groqApiKey?: string;
  promptTemplate?: string;
};

type UseSuggestionsResult = {
  clearSuggestions: () => void;
  error: string | null;
  generateSuggestions: (transcript: TranscriptChunk[]) => Promise<SuggestionBatch | null>;
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

const flattenPreviousSuggestions = (batches: SuggestionBatch[]) =>
  batches.flatMap((batch) => batch.suggestions);

export function useSuggestions({
  contextWindow,
  groqApiKey,
  promptTemplate,
}: UseSuggestionsOptions = {}): UseSuggestionsResult {
  const [suggestions, setSuggestions] = useState<SuggestionBatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateSuggestions = async (transcript: TranscriptChunk[]) => {
    if (transcript.length === 0 || isLoading) {
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/suggestions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(groqApiKey ? { "x-groq-api-key": groqApiKey } : {}),
        },
        body: JSON.stringify({
          transcript_chunk: transcript.at(-1)?.text ?? "",
          full_transcript: buildTranscriptString(transcript),
          previous_suggestions: flattenPreviousSuggestions(suggestions),
          context_window: contextWindow,
          prompt_template: promptTemplate,
        }),
      });

      const payload = (await response.json()) as SuggestionsResponse;

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Failed to generate suggestions. Check API key.");
      }

      const batch: SuggestionBatch = {
        id: uuidv4(),
        suggestions: payload.suggestions.map((suggestion) => ({
          ...suggestion,
          id: uuidv4(),
        })),
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
