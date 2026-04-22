import { NextResponse } from "next/server";
import { extractSalience } from "@/lib/salience";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import type {
  SalientCategory,
  SalienceExtractionRequest,
  SalienceExtractionResponse,
} from "@/lib/types";

const VALID_CATEGORIES: Set<SalientCategory> = new Set([
  "claim",
  "question",
  "decision",
  "commitment",
  "objection",
  "key_entity",
]);

const buildResponse = ({
  error,
  new_moments,
  resolved_ids,
}: Partial<SalienceExtractionResponse> & { error?: string }) => ({
  new_moments: new_moments ?? [],
  resolved_ids: resolved_ids ?? [],
  error,
});

const isValidOpenMoment = (
  value: unknown,
): value is SalienceExtractionRequest["open_moments"][number] => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.category === "string" &&
    VALID_CATEGORIES.has(candidate.category as SalientCategory) &&
    typeof candidate.summary === "string" &&
    typeof candidate.verbatim === "string"
  );
};

const isSalienceExtractionRequest = (value: unknown): value is SalienceExtractionRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.transcript_slice === "string" &&
    Array.isArray(candidate.open_moments)
  );
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

  if (!isSalienceExtractionRequest(payload)) {
    return NextResponse.json(
      buildResponse({ error: "Invalid salience extraction payload." }),
      { status: 400 },
    );
  }

  const sanitizedRequest: SalienceExtractionRequest = {
    transcript_slice: payload.transcript_slice,
    open_moments: payload.open_moments.filter(isValidOpenMoment),
  };

  try {
    const result = await extractSalience(apiKey.trim(), sanitizedRequest);

    return NextResponse.json(
      buildResponse(result),
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      buildResponse({ error: "Salience extraction failed" }),
      { status: 500 },
    );
  }
}
