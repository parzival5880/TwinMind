"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { isLargeModelExpandedContext } from "@/lib/llm-clients";
import { recordTelemetryEvent, startTelemetryMeasurement } from "@/lib/telemetry";
import { buildVerbatimRecent } from "@/lib/verbatim";
import type {
  RollingSummary,
  SalientMoment,
  Suggestion,
  SuggestionBatch,
  SuggestionGroundingDebug,
  SuggestionMeta,
  SuggestionPipelineDebug,
  SuggestionStreamEvent,
  TranscriptChunk,
} from "@/lib/types";

type UseSuggestionsOptions = {
  pauseWhileChatInflight?: () => boolean;
};

type GenerateSuggestionsContext = {
  rollingSummary?: RollingSummary | null;
  recentChatTopics?: string;
  salientMemory?: SalientMoment[];
  meetingType?: string;
  conversationStage?: string;
};

export type StreamingBatchState = {
  status: "streaming" | "ranking" | "retrying" | "complete" | "error";
  batchId: string;
  startedAt: number;
  suggestions: Suggestion[];
  meta?: SuggestionMeta;
  slowStream?: boolean;
  errorMessage?: string;
  candidateCount?: number;
};

export type PipelineDebugState = {
  batchId: string;
  recordedAt: number;
  pipeline: SuggestionPipelineDebug;
};

export type GroundingDebugState = {
  recordedAt: number;
  grounding: SuggestionGroundingDebug;
};

export type SuggestionSkipReason = "quiet" | "echo";

export type SuggestionSkipState = {
  reason: SuggestionSkipReason;
  since: number;
  growth: number;
  similarity: number;
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
  lastGroundingDebug: GroundingDebugState | null;
  lastPipelineDebug: PipelineDebugState | null;
  skipState: SuggestionSkipState | null;
  streamingBatches: Map<string, StreamingBatchState>;
  suggestions: SuggestionBatch[];
};

// Client budget stays strictly greater than the server-side suggestion
// timeout so server errors surface as structured responses instead of hung
// sockets. Server standard=12s / expanded=35s, client standard=15s /
// expanded=40s.
const SUGGESTIONS_FETCH_TIMEOUT_MS_STANDARD = 15_000;
const SUGGESTIONS_FETCH_TIMEOUT_MS_EXPANDED = 40_000;

// If no stream event arrives within this window, surface a soft "slow stream"
// warning. It does NOT abort — the hard abort is the fetch timeout above.
const SLOW_STREAM_HEARTBEAT_MS = 8_000;

function getSuggestionsFetchTimeoutMs(): number {
  return isLargeModelExpandedContext()
    ? SUGGESTIONS_FETCH_TIMEOUT_MS_EXPANDED
    : SUGGESTIONS_FETCH_TIMEOUT_MS_STANDARD;
}

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

const SHOULD_DEBUG_SUGGESTIONS = process.env.NODE_ENV !== "production";
const MAX_CONCURRENT_STREAMS = 2;

const createSuggestionSessionId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `suggestions-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type StreamHandlers = {
  onGrounding: (event: Extract<SuggestionStreamEvent, { type: "grounding" }>) => void;
  onMeta: (event: Extract<SuggestionStreamEvent, { type: "meta" }>) => void;
  onCritiqueStarting: (
    event: Extract<SuggestionStreamEvent, { type: "critique_starting" }>,
  ) => void;
  onCard: (event: Extract<SuggestionStreamEvent, { type: "card" }>) => void;
  onRetrying: (event: Extract<SuggestionStreamEvent, { type: "retrying" }>) => void;
  onDebug: (event: Extract<SuggestionStreamEvent, { type: "debug" }>) => void;
  onDone: (event: Extract<SuggestionStreamEvent, { type: "done" }>) => void;
  onError: (event: Extract<SuggestionStreamEvent, { type: "error" }>) => void;
};

// Reads an SSE response body and dispatches parsed frames. Returns only when
// the stream closes cleanly or the signal aborts.
async function readSuggestionsStream(
  response: Response,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  if (!response.body) {
    throw new Error("Response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are terminated by a blank line (\n\n).
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));

        if (dataLine) {
          const json = dataLine.slice(6);
          try {
            const parsed = JSON.parse(json) as SuggestionStreamEvent;
            switch (parsed.type) {
              case "meta":
                handlers.onMeta(parsed);
                break;
              case "grounding":
                handlers.onGrounding(parsed);
                break;
              case "critique_starting":
                handlers.onCritiqueStarting(parsed);
                break;
              case "card":
                handlers.onCard(parsed);
                break;
              case "retrying":
                handlers.onRetrying(parsed);
                break;
              case "debug":
                handlers.onDebug(parsed);
                break;
              case "done":
                handlers.onDone(parsed);
                break;
              case "error":
                handlers.onError(parsed);
                break;
              default:
                break;
            }
          } catch {
            // Swallow malformed frames — keep reading.
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function useSuggestions({
  pauseWhileChatInflight = () => false,
}: UseSuggestionsOptions = {}): UseSuggestionsResult {
  const [suggestions, setSuggestions] = useState<SuggestionBatch[]>([]);
  const [streamingBatches, setStreamingBatches] = useState<Map<string, StreamingBatchState>>(
    () => new Map(),
  );
  const [lastGroundingDebug, setLastGroundingDebug] = useState<GroundingDebugState | null>(null);
  const [lastPipelineDebug, setLastPipelineDebug] = useState<PipelineDebugState | null>(null);
  const [skipState, setSkipState] = useState<SuggestionSkipState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestionsRef = useRef<SuggestionBatch[]>([]);
  const activeControllersRef = useRef<Map<number, AbortController>>(new Map());
  const requestSequenceRef = useRef(0);
  const sessionIdRef = useRef(createSuggestionSessionId());

  // Dedup guard — prevents double-promotion from strict-mode or concurrent renders.
  const promotedBatchIdsRef = useRef<Set<string>>(new Set());

  const lastMeetingTypeRef = useRef<string | undefined>(undefined);
  const lastConversationStageRef = useRef<string | undefined>(undefined);
  const lastVerbatimRef = useRef<string>("");
  const backoffUntilRef = useRef<number>(0);
  const consecutiveRateLimitRef = useRef<number>(0);

  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);

  const cancelSuggestions = useCallback(() => {
    activeControllersRef.current.forEach((controller) => controller.abort());
    activeControllersRef.current.clear();
    setIsLoading(false);
    setStreamingBatches(new Map());
    promotedBatchIdsRef.current.clear();
    sessionIdRef.current = createSuggestionSessionId();
    setSkipState(null);
  }, []);

  const generateSuggestions = useCallback(
    async (
      transcript: TranscriptChunk[],
      context: GenerateSuggestionsContext = {},
      options?: {
        replacePending?: boolean;
        source?: "auto" | "manual";
      },
    ): Promise<SuggestionBatch | null> => {
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

      if (Date.now() < backoffUntilRef.current) {
        logSkip("rate-limit-backoff", {
          backoff_remaining_ms: Math.max(0, backoffUntilRef.current - Date.now()),
        });
        return null;
      }

      const isAutoSource = options?.source === "auto";

      if (isAutoSource) {
        if (pauseWhileChatInflight()) {
          logSkip("chat-inflight");
          return null;
        }

        const newVerbatim = buildVerbatimRecent(transcript);
        const newTokens = tokenize(newVerbatim);
        const oldTokens = tokenize(lastVerbatimRef.current);
        const growth = newTokens.size - oldTokens.size;

        if (growth < 8) {
          const nextSkipState: SuggestionSkipState = {
            reason: "quiet",
            since: Date.now(),
            growth,
            similarity: 0,
          };
          setSkipState(nextSkipState);
          recordTelemetryEvent("suggestions_skip_shown", {
            reason: "quiet",
            growth,
            similarity: 0,
          });
          logSkip("growth-below-threshold", {
            growth,
            threshold: 8,
            transcript_chunks: transcript.length,
          });
          return null;
        }

        const similarity = jaccard(newTokens, oldTokens);

        if (similarity > 0.8 && growth < 15) {
          const nextSkipState: SuggestionSkipState = {
            reason: "echo",
            since: Date.now(),
            growth,
            similarity,
          };
          setSkipState(nextSkipState);
          recordTelemetryEvent("suggestions_skip_shown", {
            reason: "echo",
            growth,
            similarity,
          });
          logSkip("high-similarity-low-growth", {
            growth,
            similarity,
            threshold_growth: 15,
            threshold_similarity: 0.8,
          });
          return null;
        }
      }

      if (activeControllersRef.current.size >= MAX_CONCURRENT_STREAMS && !options?.replacePending) {
        logSkip("request-cap-reached", {
          in_flight_requests: activeControllersRef.current.size,
          max_concurrent_streams: MAX_CONCURRENT_STREAMS,
        });
        return null;
      }

      if (options?.replacePending) {
        cancelSuggestions();
      }

      const requestId = requestSequenceRef.current + 1;
      const abortController = new AbortController();
      let abortedByTimeout = false;
      const abortTimeoutId = window.setTimeout(() => {
        abortedByTimeout = true;
        abortController.abort();
      }, getSuggestionsFetchTimeoutMs());
      const completeTelemetry = startTelemetryMeasurement("suggestions_first_render", {
        source: options?.source ?? "manual",
      });
      let telemetryReported = false;

      requestSequenceRef.current = requestId;
      activeControllersRef.current.set(requestId, abortController);
      setIsLoading(true);
      setError(null);
      setSkipState(null);
      if (options?.replacePending) {
        setStreamingBatches(new Map());
      }

      // Heartbeat — reset on every stream event. If it fires the streaming
      // batch is flagged `slowStream: true`. Does NOT abort.
      const pendingBatchKey = `pending-${requestId}`;
      let currentBatchId: string | null = null;
      let heartbeatId = window.setTimeout(function onSlowStream() {
        const targetBatchKey = currentBatchId ?? pendingBatchKey;
        setStreamingBatches((current) => {
          const next = new Map(current);
          const batch = next.get(targetBatchKey);
          if (!batch) {
            return current;
          }
          next.set(targetBatchKey, { ...batch, slowStream: true });
          return next;
        });
      }, SLOW_STREAM_HEARTBEAT_MS);
      const bumpHeartbeat = () => {
        window.clearTimeout(heartbeatId);
        heartbeatId = window.setTimeout(function onSlowStream() {
          const targetBatchKey = currentBatchId ?? pendingBatchKey;
          setStreamingBatches((current) => {
            const next = new Map(current);
            const batch = next.get(targetBatchKey);
            if (!batch) {
              return current;
            }
            next.set(targetBatchKey, { ...batch, slowStream: true });
            return next;
          });
        }, SLOW_STREAM_HEARTBEAT_MS);
      };

      if (SHOULD_DEBUG_SUGGESTIONS) {
        console.warn("[TwinMind][suggestions][client][dispatch]", {
          request_id: requestId,
          source: options?.source ?? "manual",
          transcript_chunks: transcript.length,
          transcript_tail: transcript.at(-1)?.text ?? "",
        });
      }

      // Client-assigned IDs keyed by server card index — stable across a
      // `replace: true` event so the DOM key doesn't remount.
      const cardUuidsByIndex = new Map<number, string>();
      let committedBatch: SuggestionBatch | null = null;
      let cardCounter = 0;
      let sawServerError = false;
      let serverErrorMessage: string | null = null;

      const debugRequested =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("debug") === "1";

      try {
        const verbatimRecent = buildVerbatimRecent(transcript);
        const response = await fetch("/api/suggestions", {
          signal: abortController.signal,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            transcript_chunk: transcript.at(-1)?.text ?? "",
            full_transcript: verbatimRecent ? "" : buildTranscriptString(transcript),
            verbatim_recent: verbatimRecent,
            rolling_summary: context.rollingSummary,
            recent_chat_topics: context.recentChatTopics,
            meeting_type: context.meetingType ?? lastMeetingTypeRef.current,
            conversation_stage: context.conversationStage ?? lastConversationStageRef.current,
            session_id: sessionIdRef.current,
            ...(context.salientMemory && context.salientMemory.length > 0
              ? { salient_memory: context.salientMemory }
              : {}),
            ...(debugRequested ? { debug: true } : {}),
          }),
        });

        if (!response.ok && response.status !== 200) {
          // Non-2xx: the server still returns SSE framing, so fall through and
          // let the reader surface the single error frame; but if content-type
          // isn't SSE, short-circuit with status-derived messaging.
          const contentType = response.headers.get("Content-Type") ?? "";
          if (!contentType.includes("text/event-stream")) {
            throw Object.assign(
              new Error(`Suggestions request failed with status ${response.status}`),
              { status: response.status },
            );
          }
        }

        await readSuggestionsStream(response, abortController.signal, {
          onGrounding: (event) => {
            bumpHeartbeat();
            console.info("[grounding]", event);
            setLastGroundingDebug({
              recordedAt: Date.now(),
              grounding: {
                entities_found: event.entities_found,
                entities: event.entities,
                searches_used: event.searches_used,
                searches_remaining: event.searches_remaining,
                cache_hits: event.cache_hits,
                facts_count: event.facts_count,
                skipped_reason: event.skipped_reason,
              },
            });
          },
          onMeta: (event) => {
            bumpHeartbeat();
            currentBatchId = event.batch_id;
            setStreamingBatches((current) => {
              const next = new Map(current);
              const existingPending = next.get(pendingBatchKey);
              next.delete(pendingBatchKey);
              next.set(event.batch_id, {
                status: "streaming",
                batchId: event.batch_id,
                startedAt: existingPending?.startedAt ?? Date.now(),
                suggestions: existingPending?.suggestions ?? [],
                slowStream: existingPending?.slowStream,
                errorMessage: existingPending?.errorMessage,
                candidateCount: existingPending?.candidateCount,
                meta: {
                  meeting_type: event.meeting_type,
                  conversation_stage: event.conversation_stage,
                  grounding: existingPending?.meta?.grounding,
                },
              });
              return next;
            });
          },
          onCritiqueStarting: (event) => {
            bumpHeartbeat();
            const targetBatchKey = currentBatchId ?? pendingBatchKey;
            setStreamingBatches((current) => {
              const next = new Map(current);
              const batch = next.get(targetBatchKey);

              if (!batch) {
                next.set(targetBatchKey, {
                  status: "ranking",
                  batchId: targetBatchKey,
                  startedAt: Date.now(),
                  suggestions: [],
                  candidateCount: event.candidate_count,
                });
                return next;
              }

              next.set(targetBatchKey, {
                ...batch,
                status: "ranking",
                candidateCount: event.candidate_count,
              });
              return next;
            });
          },
          onCard: (event) => {
            bumpHeartbeat();

            if (!telemetryReported) {
              telemetryReported = true;
              window.requestAnimationFrame(() => {
                completeTelemetry({ first_card_visible: true });
              });
            }

            const existingUuid = cardUuidsByIndex.get(event.index);
            cardCounter += 1;
            const assignedUuid = existingUuid ?? `card-${currentBatchId ?? requestId}-${cardCounter}`;
            cardUuidsByIndex.set(event.index, assignedUuid);
            const suggestionWithId: Suggestion = {
              ...event.suggestion,
              id: assignedUuid,
            };

            const targetBatchKey = currentBatchId ?? pendingBatchKey;
            setStreamingBatches((current) => {
              const next = new Map(current);
              const batch = next.get(targetBatchKey) ?? {
                status: "streaming" as const,
                batchId: targetBatchKey,
                startedAt: Date.now(),
                suggestions: [],
              };
              const nextSuggestions = batch.suggestions.slice();
              nextSuggestions[event.index] = suggestionWithId;
              next.set(targetBatchKey, {
                ...batch,
                suggestions: nextSuggestions.filter((s): s is Suggestion => Boolean(s)),
              });
              return next;
            });
          },
          onRetrying: () => {
            bumpHeartbeat();
            const targetBatchKey = currentBatchId ?? pendingBatchKey;
            setStreamingBatches((current) => {
              const next = new Map(current);
              const batch = next.get(targetBatchKey);
              if (!batch) {
                return current;
              }
              next.set(targetBatchKey, { ...batch, status: "retrying" });
              return next;
            });
          },
          onDebug: (event) => {
            setLastPipelineDebug({
              batchId: currentBatchId ?? `pending-${requestId}`,
              recordedAt: Date.now(),
              pipeline: event.pipeline,
            });
          },
          onDone: (event) => {
            bumpHeartbeat();
            const finalMeta: SuggestionMeta | undefined =
              event.meta ?? undefined;

            // Server-authoritative batch_id from the done frame.
            const doneBatchId = event.batch_id;

            // First dedup gate — ref-level, before any state setter runs.
            if (promotedBatchIdsRef.current.has(doneBatchId)) {
              if (SHOULD_DEBUG_SUGGESTIONS) {
                console.warn("[suggestions] duplicate batch promotion skipped (ref gate)", {
                  batch_id: doneBatchId,
                });
              }
              setStreamingBatches((current) => {
                const next = new Map(current);
                next.delete(doneBatchId);
                next.delete(pendingBatchKey);
                return next;
              });
              return;
            }
            promotedBatchIdsRef.current.add(doneBatchId);

            setStreamingBatches((current) => {
              const next = new Map(current);
              const currentBatch = next.get(doneBatchId) ?? next.get(pendingBatchKey);

              if (!currentBatch) {
                next.delete(doneBatchId);
                next.delete(pendingBatchKey);
                return next;
              }

              const promoted: SuggestionBatch = {
                id: doneBatchId,
                suggestions: currentBatch.suggestions,
                meta: finalMeta ?? currentBatch.meta,
                timestamp: new Date(),
              };
              committedBatch = promoted;

              startTransition(() => {
                setSuggestions((prev) => {
                  if (prev.some((batch) => batch.id === doneBatchId)) {
                    if (SHOULD_DEBUG_SUGGESTIONS) {
                      console.warn("[suggestions] duplicate batch promotion skipped (setState gate)", {
                        batch_id: doneBatchId,
                      });
                    }
                    return prev;
                  }
                  return [promoted, ...prev];
                });
              });

              next.delete(doneBatchId);
              next.delete(pendingBatchKey);
              return next;
            });

            if (finalMeta) {
              lastMeetingTypeRef.current = finalMeta.meeting_type;
              lastConversationStageRef.current = finalMeta.conversation_stage;
            }
            lastVerbatimRef.current = buildVerbatimRecent(transcript);
            consecutiveRateLimitRef.current = 0;

            if (SHOULD_DEBUG_SUGGESTIONS) {
              console.warn("[TwinMind][suggestions][client][success]", {
                request_id: requestId,
                suggestion_count: event.total_cards,
                retry_fired: event.retry_fired,
              });
            }
          },
          onError: (event) => {
            sawServerError = true;
            serverErrorMessage = event.message;

            // 429 backoff lives in the error handler branch below — but we
            // should also trigger it here if the server reports rate_limited.
            if (event.code === "rate_limited") {
              consecutiveRateLimitRef.current += 1;
              const backoffMs =
                consecutiveRateLimitRef.current >= 2 ? 120_000 : 60_000;
              backoffUntilRef.current = Date.now() + backoffMs;
              console.warn(
                `[TwinMind] Rate-limited. Backing off suggestions for ${backoffMs / 1000}s.`,
              );
            }

            const targetBatchKey = currentBatchId ?? pendingBatchKey;
            setStreamingBatches((current) => {
              const next = new Map(current);
              const batch = next.get(targetBatchKey);
              if (!batch) {
                next.set(targetBatchKey, {
                  status: "error",
                  batchId: targetBatchKey,
                  startedAt: Date.now(),
                  suggestions: [],
                  errorMessage: event.message,
                });
                return next;
              }
              next.set(targetBatchKey, { ...batch, status: "error", errorMessage: event.message });
              return next;
            });
          },
        });

        window.clearTimeout(heartbeatId);

        if (sawServerError && serverErrorMessage) {
          setError(serverErrorMessage);
          return null;
        }

        return committedBatch;
      } catch (caughtError) {
        window.clearTimeout(heartbeatId);

        if (caughtError instanceof DOMException && caughtError.name === "AbortError") {
          logSkip("request-aborted", { request_id: requestId, timed_out: abortedByTimeout });
          if (abortedByTimeout) {
            setError(
              "Suggestions refresh timed out. Will retry on the next auto-tick — or click Reload to try again now.",
            );
          } else if ((options?.source ?? "manual") === "manual") {
            setError("Previous suggestion request was cancelled — click Reload to try again.");
          }
          return null;
        }

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
        activeControllersRef.current.delete(requestId);
        setIsLoading(activeControllersRef.current.size > 0);
      }
    },
    [cancelSuggestions, pauseWhileChatInflight],
  );

  const clearSuggestions = useCallback(() => {
    cancelSuggestions();
    startTransition(() => {
      setSuggestions([]);
    });
    setError(null);
    setLastGroundingDebug(null);
    setStreamingBatches(new Map());
    setLastPipelineDebug(null);
    setSkipState(null);
    lastMeetingTypeRef.current = undefined;
    lastConversationStageRef.current = undefined;
    lastVerbatimRef.current = "";
    backoffUntilRef.current = 0;
    consecutiveRateLimitRef.current = 0;
  }, [cancelSuggestions]);

  return {
    cancelSuggestions,
    clearSuggestions,
    error,
    generateSuggestions,
    isLoading,
    lastGroundingDebug,
    lastPipelineDebug,
    skipState,
    streamingBatches,
    suggestions,
  };
}
