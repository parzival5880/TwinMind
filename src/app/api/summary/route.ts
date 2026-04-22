import { NextResponse } from "next/server";
import { initializeGroqClient, validateGroqApiKey } from "@/lib/groq-client";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import { updateRollingSummary } from "@/lib/summary";
import type { RollingSummaryRequest, RollingSummaryResponse } from "@/lib/types";

const isRollingSummaryRequest = (value: unknown): value is RollingSummaryRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.full_transcript === "string";
};

export async function POST(request: Request) {
  const payload: unknown = await request.json();

  if (!isRollingSummaryRequest(payload)) {
    const response: RollingSummaryResponse = { summary: null };
    return NextResponse.json(response);
  }

  try {
    const serverGroqKey = getServerGroqKey();

    if (!serverGroqKey) {
      return NextResponse.json(
        {
          summary: null,
          error: SERVER_GROQ_KEY_MISSING_MESSAGE,
        },
        { status: 500 },
      );
    }

    const resolvedApiKey = validateGroqApiKey(serverGroqKey);

    initializeGroqClient(resolvedApiKey);

    const summary = await updateRollingSummary(payload.full_transcript);

    const response: RollingSummaryResponse = { summary };
    return NextResponse.json(response);
  } catch {
    const response: RollingSummaryResponse = { summary: null };
    return NextResponse.json(response);
  }
}
