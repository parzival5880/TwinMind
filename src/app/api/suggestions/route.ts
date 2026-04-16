import { NextResponse } from "next/server";
import {
  APIKeyError,
  SuggestionGenerationError,
  TimeoutError,
  generateSuggestions,
  initializeGroqClient,
  validateGroqApiKey,
} from "@/lib/groq-client";
import type { Suggestion, SuggestionsRequest, SuggestionsResponse } from "@/lib/types";

const buildResponse = ({
  error,
  suggestions,
  success,
  timestamp,
}: SuggestionsResponse) => ({
  error,
  suggestions,
  success,
  timestamp,
});

const isSuggestion = (value: unknown): value is Suggestion => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.preview === "string" &&
    typeof candidate.full_content === "string"
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
    (candidate.previous_suggestions === undefined ||
      (Array.isArray(candidate.previous_suggestions) &&
        candidate.previous_suggestions.every(isSuggestion))) &&
    (candidate.context_window === undefined || typeof candidate.context_window === "number") &&
    (candidate.prompt_template === undefined || typeof candidate.prompt_template === "string")
  );
};

const resolveGroqApiKey = (request: Request) =>
  request.headers.get("x-groq-api-key") ??
  process.env.GROQ_API_KEY ??
  process.env.NEXT_PUBLIC_GROQ_API_KEY;

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const payload: unknown = await request.json();

  if (!isSuggestionsRequest(payload)) {
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

    initializeGroqClient(resolvedApiKey);

    const suggestions = await generateSuggestions(payload);

    return NextResponse.json(
      buildResponse({
        success: true,
        suggestions,
        timestamp,
      }),
    );
  } catch (error) {
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
