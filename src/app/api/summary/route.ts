import { NextResponse } from "next/server";
import { initializeGroqClient, validateGroqApiKey } from "@/lib/groq-client";
import { updateRollingSummary } from "@/lib/summary";
import type { RollingSummaryRequest, RollingSummaryResponse } from "@/lib/types";

const isRollingSummaryRequest = (value: unknown): value is RollingSummaryRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.full_transcript === "string";
};

const resolveGroqApiKey = (request: Request) =>
  request.headers.get("x-groq-api-key") ??
  process.env.GROQ_API_KEY ??
  process.env.NEXT_PUBLIC_GROQ_API_KEY;

export async function POST(request: Request) {
  const payload: unknown = await request.json();

  if (!isRollingSummaryRequest(payload)) {
    const response: RollingSummaryResponse = { summary: null };
    return NextResponse.json(response);
  }

  try {
    const resolvedApiKey = validateGroqApiKey(resolveGroqApiKey(request) ?? "");

    initializeGroqClient(resolvedApiKey);

    const summary = await updateRollingSummary(payload.full_transcript);

    const response: RollingSummaryResponse = { summary };
    return NextResponse.json(response);
  } catch {
    const response: RollingSummaryResponse = { summary: null };
    return NextResponse.json(response);
  }
}
