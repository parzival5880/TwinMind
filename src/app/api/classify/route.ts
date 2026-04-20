import { NextResponse } from "next/server";
import { classifyMeeting } from "@/lib/classifier";

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

const resolveGroqApiKey = (request: Request) =>
  request.headers.get("x-groq-api-key") ??
  process.env.GROQ_API_KEY ??
  process.env.NEXT_PUBLIC_GROQ_API_KEY;

export async function POST(request: Request) {
  const apiKey = resolveGroqApiKey(request);

  if (!apiKey?.trim()) {
    return NextResponse.json(
      buildResponse({ error: "Missing API key" }),
      { status: 401 },
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
