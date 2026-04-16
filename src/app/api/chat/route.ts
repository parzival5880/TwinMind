import { NextResponse } from "next/server";
import {
  APIKeyError,
  ChatGenerationError,
  TimeoutError,
  generateDetailedAnswer,
  initializeGroqClient,
  validateGroqApiKey,
} from "@/lib/groq-client";
import type { ChatMessage, ChatRequest, ChatResponse } from "@/lib/types";

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    typeof candidate.timestamp === "string"
  );
};

const isChatRequestBody = (value: unknown): value is ChatRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.user_message === "string" &&
    typeof candidate.full_transcript === "string" &&
    Array.isArray(candidate.chat_history) &&
    candidate.chat_history.every(isChatMessage) &&
    (candidate.context_window === undefined || typeof candidate.context_window === "number") &&
    (candidate.prompt_template === undefined || typeof candidate.prompt_template === "string")
  );
};

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

const resolveGroqApiKey = (request: Request) =>
  request.headers.get("x-groq-api-key") ??
  process.env.GROQ_API_KEY ??
  process.env.NEXT_PUBLIC_GROQ_API_KEY;

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
    const resolvedApiKey = validateGroqApiKey(resolveGroqApiKey(request) ?? "");

    initializeGroqClient(resolvedApiKey);

    const message = await generateDetailedAnswer(payload);

    return NextResponse.json(
      buildResponse({
        message,
        success: true,
        timestamp,
      }),
    );
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
