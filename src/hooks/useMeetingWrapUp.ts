"use client";

import { useCallback, useState } from "react";
import { recordTelemetryEvent } from "@/lib/telemetry";
import type { MeetingWrapUp, WrapUpRequest, WrapUpResponse } from "@/lib/types";

export function useMeetingWrapUp() {
  const [wrapUp, setWrapUp] = useState<MeetingWrapUp | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (payload: WrapUpRequest) => {
    setIsGenerating(true);
    setError(null);
    const startedAt = performance.now();

    try {
      const res = await fetch("/api/wrap-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: WrapUpResponse = await res.json();

      if (data.wrap_up) {
        setWrapUp(data.wrap_up);
        recordTelemetryEvent("meeting_wrap_up_generated", {
          transcript_chars: payload.full_transcript.length,
          agenda_count: data.wrap_up.agenda.length,
          latency_ms: Math.round(performance.now() - startedAt),
        });
      } else if (data.error) {
        setError(data.error);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const reset = useCallback(() => {
    setWrapUp(null);
    setError(null);
    setIsGenerating(false);
  }, []);

  return { wrapUp, isGenerating, error, generate, reset };
}
