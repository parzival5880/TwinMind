import OpenAI from "openai";
import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import {
  APIKeyError,
  ChatGenerationError,
  TimeoutError,
  streamDetailedAnswer,
  validateGroqApiKey,
} from "@/lib/groq-client";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContextBundle,
  RollingSummary,
  SalientMoment,
  Suggestion,
  SuggestionMeta,
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
const SALIENT_CATEGORIES = new Set([
  "claim",
  "question",
  "decision",
  "commitment",
  "objection",
  "key_entity",
]);
const SALIENT_STATUSES = new Set(["open", "addressed"]);

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    (typeof candidate.timestamp === "string" || candidate.timestamp instanceof Date)
  );
};

const isChatRequestBody = (value: unknown): value is Pick<ChatRequest, "message" | "history"> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.message === "string" &&
    Array.isArray(candidate.history) &&
    candidate.history.every(isChatMessage)
  );
};

const isSuggestionMeta = (value: unknown): value is SuggestionMeta => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.meeting_type === "string" &&
    typeof candidate.conversation_stage === "string"
  );
};

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

const isSalientMoment = (value: unknown): value is SalientMoment => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.timestamp === "number" &&
    typeof candidate.category === "string" &&
    SALIENT_CATEGORIES.has(candidate.category) &&
    typeof candidate.summary === "string" &&
    typeof candidate.verbatim === "string" &&
    typeof candidate.importance === "number" &&
    candidate.importance >= 1 &&
    candidate.importance <= 5 &&
    typeof candidate.status === "string" &&
    SALIENT_STATUSES.has(candidate.status)
  );
};

const isSuggestion = (value: unknown): value is Suggestion => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.preview === "string" &&
    typeof candidate.full_content === "string" &&
    typeof candidate.evidence_quote === "string" &&
    (candidate.trigger === undefined || typeof candidate.trigger === "string")
  );
};

const sanitizeContextBundle = (value: unknown): ContextBundle => {
  if (typeof value !== "object" || value === null) {
    return {
      rollingSummary: null,
      verbatimRecent: "",
      salientMemory: [],
      recentChatTopics: [],
    };
  }

  const candidate = value as Record<string, unknown>;

  return {
    rollingSummary: isRollingSummary(candidate.rollingSummary) ? candidate.rollingSummary : null,
    verbatimRecent: typeof candidate.verbatimRecent === "string" ? candidate.verbatimRecent : "",
    salientMemory: Array.isArray(candidate.salientMemory)
      ? candidate.salientMemory.filter(isSalientMoment)
      : [],
    meta: isSuggestionMeta(candidate.meta) ? candidate.meta : undefined,
    recentChatTopics: Array.isArray(candidate.recentChatTopics)
      ? candidate.recentChatTopics.filter((topic): topic is string => typeof topic === "string")
      : [],
  };
};

const sanitizeSuggestion = (value: unknown) => (isSuggestion(value) ? value : undefined);

const buildResponse = ({
  error,
  message,
  success,
  timestamp,
}: ChatResponse) => ({
  error,
  message,
  success,
  timestamp,
});

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const payload: unknown = await request.json();

  if (!isChatRequestBody(payload)) {
    return NextResponse.json(
      buildResponse({
        error: "Invalid chat payload.",
        message: "",
        success: false,
        timestamp,
      }),
      { status: 400 },
    );
  }

  try {
    const serverGroqKey = getServerGroqKey();

    if (!serverGroqKey) {
      return NextResponse.json(
        buildResponse({
          error: SERVER_GROQ_KEY_MISSING_MESSAGE,
          message: "",
          success: false,
          timestamp,
        }),
        { status: 500 },
      );
    }

    const resolvedApiKey = validateGroqApiKey(serverGroqKey);
    const candidate = payload as Record<string, unknown>;
    const completionStream = await streamDetailedAnswer(resolvedApiKey, {
      message: payload.message,
      history: payload.history,
      suggestion: sanitizeSuggestion(candidate.suggestion),
      context: sanitizeContextBundle(candidate.context),
    });
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sendEvent = (value: string) => {
          controller.enqueue(encoder.encode(value));
        };

        try {
          let sawContentDelta = false;
          let reasoningFallback = "";

          for await (const chunk of completionStream) {
            const token = chunk.choices[0]?.delta?.content ?? "";
            const reasoningToken =
              (
                chunk.choices[0]?.delta as
                  | {
                      reasoning_content?: string | null;
                    }
                  | undefined
              )?.reasoning_content ?? "";

            if (!token) {
              if (reasoningToken) {
                reasoningFallback += reasoningToken;
              }
              continue;
            }

            sawContentDelta = true;
            sendEvent(`data: ${JSON.stringify({ token })}\n\n`);
          }

          if (!sawContentDelta && reasoningFallback.trim()) {
            sendEvent(`data: ${JSON.stringify({ token: reasoningFallback.trim() })}\n\n`);
          }

          sendEvent("data: [DONE]\n\n");
          controller.close();
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "The response stream ended unexpectedly.";

          sendEvent(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof APIKeyError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          message: "",
          success: false,
          timestamp,
        }),
        { status: 401 },
      );
    }

    if (error instanceof TimeoutError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          message: "",
          success: false,
          timestamp,
        }),
        { status: 504 },
      );
    }

    if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return NextResponse.json(
          buildResponse({
            error: "Invalid API key",
            message: "",
            success: false,
            timestamp,
          }),
          { status: 401 },
        );
      }

      if (error.status === 429) {
        return NextResponse.json(
          buildResponse({
            error: "Rate limit hit",
            message: "",
            success: false,
            timestamp,
          }),
          { status: 429 },
        );
      }

      if (error.status === 408 || error.name === "APITimeoutError") {
        return NextResponse.json(
          buildResponse({
            error: "Request timeout",
            message: "",
            success: false,
            timestamp,
          }),
          { status: 504 },
        );
      }
    }

    const errorMessage =
      error instanceof ChatGenerationError
        ? error.message
        : "Failed to generate a detailed answer.";

    return NextResponse.json(
      buildResponse({
        error: errorMessage,
        message: "",
        success: false,
        timestamp,
      }),
      { status: 500 },
    );
  }
}
