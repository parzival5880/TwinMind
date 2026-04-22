"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SalientMoment,
  SalienceExtractionResponse,
  TranscriptChunk,
} from "@/lib/types";

type UseSalienceStoreOptions = {
  chunks: TranscriptChunk[];
  isRecording: boolean;
};

type UseSalienceStoreResult = {
  moments: SalientMoment[];
  getTopK: (k: number) => SalientMoment[];
  reset: () => void;
};

const EXTRACTION_INTERVAL_MS = 60_000;
const WARMUP_DELAY_MS = 30_000;
const MAX_STORE_SIZE = 20;
const DECAY_GRACE_MS = 10 * 60_000;
const DECAY_STEP_MS = 5 * 60_000;

const computeDecayedImportance = (
  original: number,
  momentTimestamp: number,
  now: number,
): 1 | 2 | 3 | 4 | 5 => {
  const ageMs = now - momentTimestamp;

  if (ageMs <= DECAY_GRACE_MS) {
    return Math.max(1, Math.min(5, original)) as 1 | 2 | 3 | 4 | 5;
  }

  const steps = Math.floor((ageMs - DECAY_GRACE_MS) / DECAY_STEP_MS);
  const decayed = original - steps;

  return Math.max(1, Math.min(5, decayed)) as 1 | 2 | 3 | 4 | 5;
};

const pruneToMaxSize = (moments: SalientMoment[]) => {
  if (moments.length <= MAX_STORE_SIZE) {
    return moments;
  }

  const sorted = [...moments].sort((a, b) => {
    if (a.importance !== b.importance) {
      return a.importance - b.importance;
    }
    return a.timestamp - b.timestamp;
  });

  const toDrop = new Set(
    sorted.slice(0, sorted.length - MAX_STORE_SIZE).map((m) => m.id),
  );

  return moments.filter((m) => !toDrop.has(m.id));
};

export function useSalienceStore({
  chunks,
  isRecording,
}: UseSalienceStoreOptions): UseSalienceStoreResult {
  const momentsRef = useRef<SalientMoment[]>([]);
  const [moments, setMoments] = useState<SalientMoment[]>([]);
  const watermarkRef = useRef<number>(0);
  const inflightRef = useRef<boolean>(false);
  const meetingStartRef = useRef<number>(Date.now());
  const originalImportanceMap = useRef<Map<string, number>>(new Map());

  const chunksRef = useRef(chunks);

  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);

  const runExtraction = useCallback(async () => {
    if (inflightRef.current) {
      return;
    }

    const currentChunks = chunksRef.current;
    const watermark = watermarkRef.current;

    const newChunks = currentChunks.filter(
      (c) => c.timestamp.getTime() > watermark,
    );

    if (newChunks.length === 0) {
      return;
    }

    const transcriptSlice = newChunks.map((c) => c.text).join(" ").trim();

    if (transcriptSlice.length < 40) {
      return;
    }

    const openMoments = momentsRef.current
      .filter((m) => m.status === "open")
      .map(({ id, category, summary, verbatim }) => ({
        id,
        category,
        summary,
        verbatim,
      }));

    inflightRef.current = true;

    try {
      const response = await fetch("/api/salience", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transcript_slice: transcriptSlice,
          open_moments: openMoments,
        }),
      });

      const payload = (await response.json()) as SalienceExtractionResponse;

      if (!response.ok) {
        return;
      }

      const now = Date.now();
      const impMap = originalImportanceMap.current;

      (payload.new_moments ?? []).forEach((m, index) => {
        const id = `sal-${now}-${index}`;
        const moment: SalientMoment = {
          id,
          timestamp: now,
          category: m.category,
          summary: m.summary,
          verbatim: m.verbatim,
          importance: m.importance,
          status: "open",
        };
        impMap.set(id, m.importance);
        momentsRef.current.push(moment);
      });

      (payload.resolved_ids ?? []).forEach((resolvedId) => {
        const match = momentsRef.current.find((m) => m.id === resolvedId);

        if (match && match.status === "open") {
          match.status = "addressed";
          match.addressed_at = now;
        }
      });

      momentsRef.current.forEach((m) => {
        if (m.status !== "open") {
          return;
        }

        const original = impMap.get(m.id) ?? m.importance;
        m.importance = computeDecayedImportance(original, m.timestamp, now);
      });

      momentsRef.current = pruneToMaxSize(momentsRef.current);

      const maxChunkTs = Math.max(
        ...newChunks.map((c) => c.timestamp.getTime()),
      );
      watermarkRef.current = maxChunkTs;

      setMoments([...momentsRef.current]);
    } catch (err) {
      console.warn("[salience] hook fetch failed:", err);
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    meetingStartRef.current = Date.now();

    const warmupId = window.setTimeout(() => {
      void runExtraction();
    }, WARMUP_DELAY_MS);

    const intervalId = window.setInterval(() => {
      void runExtraction();
    }, EXTRACTION_INTERVAL_MS);

    return () => {
      window.clearTimeout(warmupId);
      window.clearInterval(intervalId);
    };
  }, [isRecording, runExtraction]);

  const getTopK = useCallback(
    (k: number): SalientMoment[] => {
      const now = Date.now();
      const meetingAgeMs = Math.max(1, now - meetingStartRef.current);

      return momentsRef.current
        .filter((m) => m.status === "open")
        .map((m) => {
          const ageMs = now - m.timestamp;
          const recencyWeight = 1 - Math.min(0.5, (ageMs / meetingAgeMs) * 0.5);
          const score = m.importance * recencyWeight;

          return { moment: m, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((entry) => entry.moment);
    },
    [],
  );

  const reset = useCallback(() => {
    momentsRef.current = [];
    originalImportanceMap.current.clear();
    setMoments([]);
    watermarkRef.current = 0;
    inflightRef.current = false;
    meetingStartRef.current = Date.now();
  }, []);

  return {
    moments,
    getTopK,
    reset,
  };
}
