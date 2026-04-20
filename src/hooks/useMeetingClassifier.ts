"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptChunk } from "@/lib/types";

type UseMeetingClassifierOptions = {
  enabled: boolean;
  groqApiKey?: string;
  recordingDurationMs: number;
  transcript: TranscriptChunk[];
};

type UseMeetingClassifierResult = {
  classifiedType: string;
  confidence: number;
  reclassify: () => Promise<void>;
};

const CLASSIFY_AFTER_MS = 60_000;

const buildTranscriptString = (transcript: TranscriptChunk[]) =>
  transcript
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";
      return `[${chunk.timestamp.toISOString()}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

export function useMeetingClassifier({
  enabled,
  groqApiKey,
  recordingDurationMs,
  transcript,
}: UseMeetingClassifierOptions): UseMeetingClassifierResult {
  const [classifiedType, setClassifiedType] = useState("default");
  const [confidence, setConfidence] = useState(0);
  const transcriptString = useMemo(() => buildTranscriptString(transcript), [transcript]);
  const hasAutoClassifiedRef = useRef(false);
  const inFlightRef = useRef(false);

  const classify = useCallback(async () => {
    if (inFlightRef.current || !groqApiKey?.trim() || !transcriptString.trim()) {
      return;
    }

    inFlightRef.current = true;

    try {
      const response = await fetch("/api/classify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": groqApiKey,
        },
        body: JSON.stringify({
          transcript: transcriptString,
        }),
      });

      const payload = (await response.json()) as {
        confidence?: number;
        meeting_type?: string;
      };

      setClassifiedType(payload.meeting_type?.trim() || "default");
      setConfidence(typeof payload.confidence === "number" ? payload.confidence : 0);
    } catch {
      setClassifiedType("default");
      setConfidence(0);
    } finally {
      inFlightRef.current = false;
    }
  }, [groqApiKey, transcriptString]);

  useEffect(() => {
    if (!enabled || hasAutoClassifiedRef.current) {
      return;
    }

    if (recordingDurationMs < CLASSIFY_AFTER_MS || !transcriptString.trim()) {
      return;
    }

    hasAutoClassifiedRef.current = true;
    void classify();
  }, [classify, enabled, recordingDurationMs, transcriptString]);

  const reclassify = useCallback(async () => {
    await classify();
  }, [classify]);

  return {
    classifiedType,
    confidence,
    reclassify,
  };
}
