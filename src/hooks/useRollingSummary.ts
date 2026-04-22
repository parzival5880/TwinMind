"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RollingSummary, RollingSummaryResponse, TranscriptChunk } from "@/lib/types";

type UseRollingSummaryOptions = {
  enabled: boolean;
  transcript: TranscriptChunk[];
};

type UseRollingSummaryResult = {
  rollingSummary: RollingSummary | null;
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

const buildTranscriptText = (chunks: TranscriptChunk[]) =>
  chunks
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";
      return `[${chunk.timestamp.toISOString()}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

export function useRollingSummary({
  enabled,
  transcript,
}: UseRollingSummaryOptions): UseRollingSummaryResult {
  const [rollingSummary, setRollingSummary] = useState<RollingSummary | null>(null);
  const summaryWatermarkRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const transcriptRef = useRef(transcript);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

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

    inFlightRef.current = true;

    try {
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          full_transcript: buildTranscriptText(currentTranscript),
        }),
      });

      const payload = (await response.json()) as RollingSummaryResponse;

      if (!response.ok || payload.summary === null) {
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
    setRollingSummary(null);
    summaryWatermarkRef.current = null;
  }, []);

  return {
    rollingSummary,
    resetSummary,
  };
}
