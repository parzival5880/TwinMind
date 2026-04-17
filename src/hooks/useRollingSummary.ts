"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RollingSummaryResponse, TranscriptChunk } from "@/lib/types";

type UseRollingSummaryOptions = {
  enabled: boolean;
  groqApiKey?: string;
  transcript: TranscriptChunk[];
};

type UseRollingSummaryResult = {
  rollingSummary: string;
  resetSummary: () => void;
};

// Any chunk older than this threshold from the newest chunk is considered
// "rolled out of verbatim" and eligible to be absorbed into the summary.
const VERBATIM_WINDOW_MS = 90_000;

// We run the summary update on a 3-minute cadence. This keeps the small
// model cost low while still giving the suggestion model fresh compressed
// context by the time the verbatim window has shifted substantially.
const SUMMARY_UPDATE_INTERVAL_MS = 180_000;

// Only fire the summary update when at least this many seconds of new
// content are waiting to be absorbed. Prevents spamming the API when there
// is essentially nothing new to compress.
const MIN_ROLLOUT_CHUNKS = 3;

const toSummaryChunk = (chunk: TranscriptChunk) => ({
  timestamp: chunk.timestamp.toISOString(),
  text: chunk.text,
  speaker: chunk.speaker,
});

export function useRollingSummary({
  enabled,
  groqApiKey,
  transcript,
}: UseRollingSummaryOptions): UseRollingSummaryResult {
  const [rollingSummary, setRollingSummary] = useState("");
  const summaryWatermarkRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const transcriptRef = useRef(transcript);
  const rollingSummaryRef = useRef(rollingSummary);
  const groqApiKeyRef = useRef(groqApiKey);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    rollingSummaryRef.current = rollingSummary;
  }, [rollingSummary]);

  useEffect(() => {
    groqApiKeyRef.current = groqApiKey;
  }, [groqApiKey]);

  const updateSummary = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }

    const currentTranscript = transcriptRef.current;

    if (currentTranscript.length === 0) {
      return;
    }

    const newestTimestamp = currentTranscript[currentTranscript.length - 1].timestamp.getTime();
    const verbatimCutoff = newestTimestamp - VERBATIM_WINDOW_MS;
    const watermark = summaryWatermarkRef.current ?? 0;

    const rolloutChunks = currentTranscript.filter((chunk) => {
      const chunkTime = chunk.timestamp.getTime();

      return chunkTime > watermark && chunkTime < verbatimCutoff;
    });

    if (rolloutChunks.length < MIN_ROLLOUT_CHUNKS) {
      return;
    }

    const apiKey = groqApiKeyRef.current;

    if (!apiKey) {
      return;
    }

    inFlightRef.current = true;

    try {
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": apiKey,
        },
        body: JSON.stringify({
          existing_summary: rollingSummaryRef.current,
          new_chunks: rolloutChunks.map(toSummaryChunk),
        }),
      });

      const payload = (await response.json()) as RollingSummaryResponse;

      if (!response.ok || !payload.success) {
        return;
      }

      const newestRolloutTime = rolloutChunks[rolloutChunks.length - 1].timestamp.getTime();
      summaryWatermarkRef.current = newestRolloutTime;
      setRollingSummary(payload.summary);
    } catch {
      // Summary is a best-effort enrichment — swallow transient errors.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void updateSummary();
    }, SUMMARY_UPDATE_INTERVAL_MS);

    // Kick off an initial update shortly after the session starts so long-
    // running meetings begin benefiting from the compressed context quickly.
    const warmupId = window.setTimeout(() => {
      void updateSummary();
    }, SUMMARY_UPDATE_INTERVAL_MS / 2);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(warmupId);
    };
  }, [enabled, updateSummary]);

  const resetSummary = useCallback(() => {
    setRollingSummary("");
    summaryWatermarkRef.current = null;
  }, []);

  return {
    rollingSummary,
    resetSummary,
  };
}
