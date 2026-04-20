import OpenAI from "openai";
import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import {
  APIKeyError,
  SuggestionGenerationError,
  TimeoutError,
  generateSuggestions,
  initializeGroqClient,
  validateGroqApiKey,
} from "@/lib/groq-client";
import { auditGrounding } from "@/lib/grounding-audit";
import { isLargeModelExpandedContext } from "@/lib/llm-clients";
import { renderRollingSummary, renderSalientMemory } from "@/lib/prompts";
import type {
  RollingSummary,
  SalientMoment,
  SuggestionsRequest,
  SuggestionsResponse,
} from "@/lib/types";

export const runtime = "edge";

const buildResponse = ({
  error,
  meta,
  suggestions,
  success,
  timestamp,
}: SuggestionsResponse) => ({
  error,
  meta,
  suggestions,
  success,
  timestamp,
});


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
    (candidate.context_window === undefined || typeof candidate.context_window === "number") &&
    (candidate.prompt_template === undefined || typeof candidate.prompt_template === "string") &&
    (candidate.meeting_type === undefined || typeof candidate.meeting_type === "string") &&
    (candidate.conversation_stage === undefined ||
      typeof candidate.conversation_stage === "string") &&
    (candidate.salient_memory === undefined || Array.isArray(candidate.salient_memory))
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

const TOP_K_SALIENCE = isLargeModelExpandedContext() ? 12 : 8;

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

const resolveGroqApiKey = (request: Request) =>
  request.headers.get("x-groq-api-key") ??
  process.env.GROQ_API_KEY ??
  process.env.NEXT_PUBLIC_GROQ_API_KEY;

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const payload: unknown = await request.json();

  console.warn("[TwinMind][suggestions][route][reached]", {
    has_groq_header: Boolean(request.headers.get("x-groq-api-key")),
    timestamp,
  });

  if (!isSuggestionsRequest(payload)) {
    console.warn("[TwinMind][suggestions][route][invalid-payload]", {
      timestamp,
    });
    return NextResponse.json(
      buildResponse({
        error: "Invalid suggestions payload.",
        success: false,
        suggestions: [],
        timestamp,
      }),
      { status: 400 },
    );
  }

  try {
    const resolvedApiKey = validateGroqApiKey(resolveGroqApiKey(request) ?? "");

    console.warn("[TwinMind][suggestions][route][validated]", {
      has_salient_memory:
        Array.isArray(payload.salient_memory) && payload.salient_memory.length > 0,
      has_verbatim_recent: Boolean(payload.verbatim_recent?.trim()),
      meeting_type: payload.meeting_type,
      conversation_stage: payload.conversation_stage,
      provider_mode: process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY
        ? "azure-large-model"
        : "groq-only",
      transcript_chunk_length: payload.transcript_chunk.length,
    });

    initializeGroqClient(resolvedApiKey);

    let salientMemoryRendered: string | undefined;

    if (Array.isArray(payload.salient_memory) && payload.salient_memory.length > 0) {
      const validMoments = payload.salient_memory.filter(isValidSalientMoment);

      if (validMoments.length > 0) {
        const top8 = scoreSalientMoments(validMoments);
        salientMemoryRendered = renderSalientMemory(top8);
      }
    }

    const normalizedPayload: SuggestionsRequest = {
      ...payload,
      rolling_summary: typeof payload.rolling_summary === "string"
        ? payload.rolling_summary
        : renderRollingSummary(payload.rolling_summary ?? null),
    };

    const { suggestions, meta } = await generateSuggestions(
      normalizedPayload,
      salientMemoryRendered,
    );

    let filteredSuggestions = suggestions;
    let groundingAudit: Array<{ id: string; grounded: boolean; score: number }> | undefined;

    if (process.env.STRICT_GROUNDING === "1") {
      const auditResult = await auditGrounding(resolvedApiKey, {
        suggestions,
        verbatimRecent: payload.verbatim_recent ?? "",
      });

      if (auditResult.results.length > 0) {
        groundingAudit = auditResult.results.map(({ grounded, id, score }) => ({
          id,
          grounded,
          score,
        }));

        const passingIds = new Set(
          auditResult.results
            .filter((result) => result.grounded && result.score > 1)
            .map((result) => result.id),
        );
        const survivors = suggestions.filter((suggestion) => passingIds.has(suggestion.id));

        if (survivors.length > 0 && survivors.length < suggestions.length) {
          filteredSuggestions = survivors;
        }
      }
    }

    return NextResponse.json(
      buildResponse({
        success: true,
        suggestions: filteredSuggestions,
        meta: groundingAudit
          ? {
              ...meta,
              grounding_audit: groundingAudit,
            }
          : meta,
        timestamp,
      }),
    );
  } catch (error) {
    console.error("[TwinMind][suggestions][route][error]", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "unknown",
      status: error instanceof OpenAI.APIError || error instanceof Groq.APIError ? error.status : undefined,
      timestamp,
    });

    if (error instanceof APIKeyError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          success: false,
          suggestions: [],
          timestamp,
        }),
        { status: 401 },
      );
    }

    if (error instanceof TimeoutError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          success: false,
          suggestions: [],
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
            success: false,
            suggestions: [],
            timestamp,
          }),
          { status: 401 },
        );
      }

      if (error.status === 429) {
        return NextResponse.json(
          buildResponse({
            error: "Rate limit hit",
            success: false,
            suggestions: [],
            timestamp,
          }),
          { status: 429 },
        );
      }

      if (error.status === 408 || error.name === "APITimeoutError") {
        return NextResponse.json(
          buildResponse({
            error: "Request timeout",
            success: false,
            suggestions: [],
            timestamp,
          }),
          { status: 504 },
        );
      }
    }

    const errorMessage =
      error instanceof SuggestionGenerationError
        ? error.message
        : "Failed to generate suggestions. Check API key.";

    return NextResponse.json(
      buildResponse({
        error: errorMessage,
        success: false,
        suggestions: [],
        timestamp,
      }),
      { status: 500 },
    );
  }
}
