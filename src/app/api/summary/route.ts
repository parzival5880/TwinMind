import { NextResponse } from "next/server";
import { APIKeyError, TimeoutError, initializeGroqClient, validateGroqApiKey } from "@/lib/groq-client";
import { updateRollingSummary } from "@/lib/summary";
import type { RollingSummaryRequest, RollingSummaryResponse } from "@/lib/types";

const buildResponse = ({
  error,
  success,
  summary,
  timestamp,
}: RollingSummaryResponse) => ({
  error,
  success,
  summary,
  timestamp,
});

const isRollingSummaryRequest = (value: unknown): value is RollingSummaryRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.existing_summary !== "string") {
    return false;
  }

  if (!Array.isArray(candidate.new_chunks)) {
    return false;
  }

  return candidate.new_chunks.every((chunk) => {
    if (typeof chunk !== "object" || chunk === null) {
      return false;
    }

    const candidateChunk = chunk as Record<string, unknown>;

    return (
      typeof candidateChunk.timestamp === "string" &&
      typeof candidateChunk.text === "string" &&
      (candidateChunk.speaker === undefined || typeof candidateChunk.speaker === "string")
    );
  });
};

const resolveGroqApiKey = (request: Request) =>
  request.headers.get("x-groq-api-key") ??
  process.env.GROQ_API_KEY ??
  process.env.NEXT_PUBLIC_GROQ_API_KEY;

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const payload: unknown = await request.json();

  if (!isRollingSummaryRequest(payload)) {
    return NextResponse.json(
      buildResponse({
        error: "Invalid summary payload.",
        success: false,
        summary: "",
        timestamp,
      }),
      { status: 400 },
    );
  }

  try {
    const resolvedApiKey = validateGroqApiKey(resolveGroqApiKey(request) ?? "");

    initializeGroqClient(resolvedApiKey);

    const summary = await updateRollingSummary(payload.existing_summary, payload.new_chunks);

    return NextResponse.json(
      buildResponse({
        success: true,
        summary,
        timestamp,
      }),
    );
  } catch (error) {
    if (error instanceof APIKeyError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          success: false,
          summary: payload.existing_summary,
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
          summary: payload.existing_summary,
          timestamp,
        }),
        { status: 504 },
      );
    }

    const errorMessage = error instanceof Error ? error.message : "Failed to update summary.";

    return NextResponse.json(
      buildResponse({
        error: errorMessage,
        success: false,
        summary: payload.existing_summary,
        timestamp,
      }),
      { status: 500 },
    );
  }
}
