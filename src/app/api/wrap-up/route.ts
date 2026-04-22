import { NextResponse } from "next/server";
import { extractAssistantText, extractJsonObject, validateGroqApiKey } from "@/lib/groq-client";
import { getLargeModelClient, getLargeModelName } from "@/lib/llm-clients";
import { buildWrapUpPrompt } from "@/lib/prompts";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import type { WrapUpRequest, WrapUpResponse } from "@/lib/types";

export const runtime = "edge";

type WrapUpPayload = {
  gist?: unknown;
  agenda?: unknown;
};

const isWrapUpRequest = (value: unknown): value is WrapUpRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.full_transcript === "string" &&
    (candidate.rolling_summary === undefined ||
      candidate.rolling_summary === null ||
      typeof candidate.rolling_summary === "object") &&
    (candidate.salient_memory === undefined || Array.isArray(candidate.salient_memory)) &&
    (candidate.meeting_type === undefined || typeof candidate.meeting_type === "string")
  );
};

const parseWrapUp = (value: WrapUpPayload): WrapUpResponse["wrap_up"] => {
  const gist = typeof value.gist === "string" ? value.gist.trim() : "";
  const agenda = Array.isArray(value.agenda)
    ? value.agenda
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  if (!gist || agenda.length < 1 || agenda.length > 6 || agenda.some((item) => item.length > 80)) {
    return null;
  }

  return {
    gist,
    agenda,
    generated_at: new Date().toISOString(),
  };
};

export async function POST(request: Request) {
  const payload: unknown = await request.json();

  if (!isWrapUpRequest(payload)) {
    return NextResponse.json({ wrap_up: null, error: "Invalid wrap-up payload." }, { status: 400 });
  }

  const serverGroqKey = getServerGroqKey();

  if (!serverGroqKey) {
    return NextResponse.json(
      { wrap_up: null, error: SERVER_GROQ_KEY_MISSING_MESSAGE },
      { status: 500 },
    );
  }

  const apiKey = validateGroqApiKey(serverGroqKey);
  const client = getLargeModelClient(apiKey);
  const prompt = buildWrapUpPrompt({
    fullTranscript: payload.full_transcript,
    rollingSummary: payload.rolling_summary,
    salientMemory: payload.salient_memory,
    meetingType: payload.meeting_type,
  });

  try {
    const completion = await client.chat.completions.create(
      {
        model: getLargeModelName(),
        messages: [
          {
            role: "system",
            content: "You are a meeting wrap-up generator. Return strict JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
      },
      {
        timeout: 25_000,
        maxRetries: 0,
      },
    );

    const rawContent = extractAssistantText(completion.choices[0]?.message);

    if (!rawContent) {
      return NextResponse.json({ wrap_up: null, error: "Wrap-up returned no content." });
    }

    const parsed = JSON.parse(extractJsonObject(rawContent)) as WrapUpPayload;
    const wrapUp = parseWrapUp(parsed);

    if (!wrapUp) {
      return NextResponse.json({
        wrap_up: null,
        error: "Wrap-up response failed validation.",
      });
    }

    return NextResponse.json({ wrap_up: wrapUp });
  } catch (caughtError) {
    return NextResponse.json({
      wrap_up: null,
      error: caughtError instanceof Error ? caughtError.message : "Failed to generate wrap-up.",
    });
  }
}
