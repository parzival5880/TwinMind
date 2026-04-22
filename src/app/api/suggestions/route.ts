import {
  APIKeyError,
  validateGroqApiKey,
} from "@/lib/groq-client";
import { isLargeModelExpandedContext } from "@/lib/llm-clients";
import { renderRollingSummary, renderSalientMemory } from "@/lib/prompts";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import { generateSuggestionsPipeline, PipelineAbortedError } from "@/lib/suggestion-pipeline";
import type {
  RollingSummary,
  SalientMoment,
  SuggestionStreamEvent,
  SuggestionsRequest,
} from "@/lib/types";

export const runtime = "edge";

const ROLLING_SUMMARY_PHASES = new Set([
  "exploring",
  "converging",
  "deciding",
  "wrapping",
  "unclear",
]);
const ROLLING_SUMMARY_TONES = new Set([
  "analytical",
  "tense",
  "aligned",
  "stalled",
  "exploratory",
  "neutral",
]);

const isRollingSummary = (value: unknown): value is RollingSummary => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.topic === "string" &&
    typeof candidate.stance === "string" &&
    typeof candidate.phase === "string" &&
    ROLLING_SUMMARY_PHASES.has(candidate.phase) &&
    typeof candidate.tone === "string" &&
    ROLLING_SUMMARY_TONES.has(candidate.tone) &&
    Array.isArray(candidate.participants_heard) &&
    candidate.participants_heard.every((participant) => typeof participant === "string")
  );
};

const isSuggestionsRequest = (value: unknown): value is SuggestionsRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.transcript_chunk === "string" &&
    typeof candidate.full_transcript === "string" &&
    (candidate.verbatim_recent === undefined || typeof candidate.verbatim_recent === "string") &&
    (candidate.rolling_summary === undefined ||
      candidate.rolling_summary === null ||
      typeof candidate.rolling_summary === "string" ||
      isRollingSummary(candidate.rolling_summary)) &&
    (candidate.recent_chat_topics === undefined ||
      typeof candidate.recent_chat_topics === "string") &&
    (candidate.avoid_phrases === undefined ||
      (Array.isArray(candidate.avoid_phrases) &&
        candidate.avoid_phrases.every((phrase) => typeof phrase === "string"))) &&
    (candidate.meeting_type === undefined || typeof candidate.meeting_type === "string") &&
    (candidate.conversation_stage === undefined ||
      typeof candidate.conversation_stage === "string") &&
    (candidate.salient_memory === undefined || Array.isArray(candidate.salient_memory)) &&
    (candidate.session_id === undefined || typeof candidate.session_id === "string") &&
    (candidate.debug === undefined || typeof candidate.debug === "boolean")
  );
};

const SALIENT_CATEGORIES = new Set([
  "claim", "question", "decision", "commitment", "objection", "key_entity",
]);
const SALIENT_STATUSES = new Set(["open", "addressed"]);

const isValidSalientMoment = (value: unknown): value is SalientMoment => {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.timestamp === "number" &&
    typeof c.category === "string" && SALIENT_CATEGORIES.has(c.category) &&
    typeof c.summary === "string" &&
    typeof c.verbatim === "string" &&
    typeof c.importance === "number" && c.importance >= 1 && c.importance <= 5 &&
    typeof c.status === "string" && SALIENT_STATUSES.has(c.status)
  );
};

const TOP_K_SALIENCE = isLargeModelExpandedContext() ? 24 : 8;

const scoreSalientMoments = (moments: SalientMoment[]): SalientMoment[] => {
  const now = Date.now();
  const meetingAgeMs = moments.length > 0
    ? Math.max(1, now - Math.min(...moments.map((m) => m.timestamp)))
    : 1;

  return [...moments]
    .map((m) => {
      const ageMs = now - m.timestamp;
      const recencyWeight = 1 - Math.min(0.5, (ageMs / meetingAgeMs) * 0.5);
      const score = m.importance * recencyWeight;
      return { moment: m, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_SALIENCE)
    .map((entry) => entry.moment);
};

const SSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
  "X-Accel-Buffering": "no",
};

const encodeFrame = (encoder: TextEncoder, event: SuggestionStreamEvent): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

const errorStream = (event: SuggestionStreamEvent, status: number): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeFrame(encoder, event));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
    status,
  });
};

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const requestStartedAt = Date.now();
  const payload: unknown = await request.json();

  console.warn("[TwinMind][suggestions][route][reached]", { timestamp });

  if (!isSuggestionsRequest(payload)) {
    console.warn("[TwinMind][suggestions][route][invalid-payload]", { timestamp });
    return errorStream(
      { type: "error", message: "Invalid suggestions payload.", code: "invalid_payload" },
      400,
    );
  }

  const serverGroqKey = getServerGroqKey();

  if (!serverGroqKey) {
    return errorStream(
      { type: "error", message: SERVER_GROQ_KEY_MISSING_MESSAGE, code: "missing_key" },
      500,
    );
  }

  let resolvedApiKey: string;

  try {
    resolvedApiKey = validateGroqApiKey(serverGroqKey);
  } catch (error) {
    if (error instanceof APIKeyError) {
      return errorStream(
        { type: "error", message: error.message, code: "invalid_key" },
        401,
      );
    }
    return errorStream(
      { type: "error", message: "Failed to validate API key.", code: "invalid_key" },
      401,
    );
  }

  console.warn("[TwinMind][suggestions][route][validated]", {
    has_salient_memory:
      Array.isArray(payload.salient_memory) && payload.salient_memory.length > 0,
    has_verbatim_recent: Boolean(payload.verbatim_recent?.trim()),
    meeting_type: payload.meeting_type,
    conversation_stage: payload.conversation_stage,
    provider_mode:
      process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY
        ? "azure-large-model"
        : "groq-only",
    transcript_chunk_length: payload.transcript_chunk.length,
  });

  let salientMemoryRendered: string | undefined;

  if (Array.isArray(payload.salient_memory) && payload.salient_memory.length > 0) {
    const validMoments = payload.salient_memory.filter(isValidSalientMoment);

    if (validMoments.length > 0) {
      const top = scoreSalientMoments(validMoments);
      salientMemoryRendered = renderSalientMemory(top);
    }
  }

  const normalizedPayload: SuggestionsRequest = {
    ...payload,
    rolling_summary:
      typeof payload.rolling_summary === "string"
        ? payload.rolling_summary
        : renderRollingSummary(payload.rolling_summary ?? null),
  };

  const encoder = new TextEncoder();
  const clientAbort = request.signal;
  const upstreamAbortController = new AbortController();
  let disconnectLogged = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const logDisconnect = () => {
        if (disconnectLogged) {
          return;
        }

        disconnectLogged = true;
        console.info("[suggestions][server] client disconnected mid-stream", {
          request_id: requestId,
          elapsed_ms: Date.now() - requestStartedAt,
        });
      };

      const isDisconnectError = (error: unknown) =>
        clientAbort.aborted ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "ECONNRESET") ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError");

      const safeEnqueue = (event: SuggestionStreamEvent) => {
        if (closed || clientAbort.aborted || upstreamAbortController.signal.aborted) {
          return;
        }
        try {
          controller.enqueue(encodeFrame(encoder, event));
        } catch (error) {
          if (isDisconnectError(error)) {
            logDisconnect();
            closed = true;
            return;
          }
          closed = true;
          throw error;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      const onClientAbort = () => {
        if (!upstreamAbortController.signal.aborted) {
          upstreamAbortController.abort();
        }
        logDisconnect();
        safeClose();
      };

      clientAbort.addEventListener("abort", onClientAbort);
      if (clientAbort.aborted) {
        onClientAbort();
        return;
      }

      try {
        await generateSuggestionsPipeline(
          resolvedApiKey,
          normalizedPayload,
          salientMemoryRendered,
          {
            onGrounding: (grounding) => {
              safeEnqueue({
                type: "grounding",
                entities_found: grounding.entities_found,
                entities: grounding.entities,
                searches_used: grounding.searches_used,
                searches_remaining: grounding.searches_remaining,
                cache_hits: grounding.cache_hits,
                facts_count: grounding.facts_count,
                ...(grounding.skipped_reason ? { skipped_reason: grounding.skipped_reason } : {}),
              });
            },
            onMeta: (meta) => {
              safeEnqueue({
                type: "meta",
                batch_id: meta.batch_id,
                generated_at: meta.generated_at,
                meeting_type: meta.meeting_type,
                conversation_stage: meta.conversation_stage,
              });
            },
            onCritiqueStarting: (candidateCount) => {
              safeEnqueue({
                type: "critique_starting",
                candidate_count: candidateCount,
              });
            },
            onCard: (suggestion, index, opts) => {
              safeEnqueue({
                type: "card",
                index,
                suggestion,
                ...(opts?.replace ? { replace: true } : {}),
              });
            },
            onRetrying: (reason) => {
              safeEnqueue({ type: "retrying", reason });
            },
            onDebug: (pipeline) => {
              safeEnqueue({ type: "debug", pipeline });
            },
            onDone: (summary) => {
              safeEnqueue({
                type: "done",
                batch_id: summary.batch_id,
                total_cards: summary.total_cards,
                critique_used: summary.critique_used,
                retry_fired: summary.retry_fired,
                meta: summary.meta,
              });
            },
            onError: (message, code) => {
              safeEnqueue({ type: "error", message, code });
            },
          },
          { signal: upstreamAbortController.signal, debug: payload.debug === true },
        );
      } catch (error) {
        if (error instanceof PipelineAbortedError || isDisconnectError(error)) {
          logDisconnect();
          return;
        }
        console.error("[TwinMind][suggestions][route][error]", {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "unknown",
          request_id: requestId,
          timestamp,
        });
        safeEnqueue({
          type: "error",
          message:
            error instanceof Error ? error.message : "Failed to generate suggestions.",
          code: "unknown",
        });
      } finally {
        clientAbort.removeEventListener("abort", onClientAbort);
        if (!upstreamAbortController.signal.aborted) {
          upstreamAbortController.abort();
        }
        safeClose();
      }
    },
    cancel() {
      if (!upstreamAbortController.signal.aborted) {
        upstreamAbortController.abort();
      }
      if (clientAbort.aborted && !disconnectLogged) {
        disconnectLogged = true;
        console.info("[suggestions][server] client disconnected mid-stream", {
          request_id: requestId,
          elapsed_ms: Date.now() - requestStartedAt,
        });
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
