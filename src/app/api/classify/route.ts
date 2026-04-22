import { NextResponse } from "next/server";
import { classifyMeeting } from "@/lib/classifier";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";

const buildResponse = ({
  confidence,
  error,
  meeting_type,
}: {
  confidence?: number;
  error?: string;
  meeting_type?: string;
}) => ({
  confidence: confidence ?? 0,
  error,
  meeting_type: meeting_type ?? "default",
});

const isClassifyRequest = (value: unknown): value is { transcript: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return typeof candidate.transcript === "string";
};

export async function POST(request: Request) {
  const apiKey = getServerGroqKey();

  if (!apiKey?.trim()) {
    return NextResponse.json(
      buildResponse({ error: SERVER_GROQ_KEY_MISSING_MESSAGE }),
      { status: 500 },
    );
  }

  const payload: unknown = await request.json();

  if (!isClassifyRequest(payload)) {
    return NextResponse.json(
      buildResponse({ error: "Invalid classification payload." }),
      { status: 400 },
    );
  }

  try {
    const result = await classifyMeeting(apiKey.trim(), payload.transcript);

    return NextResponse.json(buildResponse(result), { status: 200 });
  } catch {
    return NextResponse.json(
      buildResponse({ error: "Classification failed" }),
      { status: 500 },
    );
  }
}
