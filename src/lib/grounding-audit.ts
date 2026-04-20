import Groq from "groq-sdk";
import { validateGroqApiKey } from "@/lib/groq-client";
import type { Suggestion } from "@/lib/types";

const AUDIT_MODEL = "llama-3.1-8b-instant";
const AUDIT_TIMEOUT_MS = 8_000;
const AUDIT_MAX_TOKENS = 500;

type AuditScore = 1 | 2 | 3;

type AuditResult = {
  id: string;
  grounded: boolean;
  score: AuditScore;
  reason?: string;
};

type AuditResponse = {
  results: AuditResult[];
};

const isAuditScore = (value: unknown): value is AuditScore =>
  value === 1 || value === 2 || value === 3;

const isAuditResult = (value: unknown): value is AuditResult => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.grounded === "boolean" &&
    isAuditScore(candidate.score) &&
    (candidate.reason === undefined || typeof candidate.reason === "string")
  );
};

const isAuditResponse = (value: unknown): value is AuditResponse => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return Array.isArray(candidate.results) && candidate.results.every(isAuditResult);
};

export async function auditGrounding(
  apiKey: string,
  input: {
    suggestions: Suggestion[];
    verbatimRecent: string;
  },
): Promise<{
  results: Array<{ id: string; grounded: boolean; score: 1 | 2 | 3; reason?: string }>;
}> {
  if (!input.verbatimRecent.trim() || input.suggestions.length === 0) {
    return { results: [] };
  }

  try {
    const client = new Groq({
      apiKey: validateGroqApiKey(apiKey),
      dangerouslyAllowBrowser: false,
      maxRetries: 0,
      timeout: AUDIT_TIMEOUT_MS,
    });

    const serializedSuggestions = input.suggestions.map((suggestion) => ({
      id: suggestion.id,
      preview: suggestion.preview,
      evidence_quote: suggestion.evidence_quote,
      why_relevant: suggestion.why_relevant,
    }));

    const completion = await client.chat.completions.create(
      {
        model: AUDIT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "For each suggestion, rate 1-3 whether the evidence_quote genuinely supports the preview given the verbatim_recent context. 3 = quote clearly supports preview; 2 = quote is related but weak support; 1 = quote does not support preview or is out-of-context. Never grant 3 unless the linkage is concrete.",
          },
          {
            role: "user",
            content: `verbatim_recent:
${input.verbatimRecent}

suggestions:
${JSON.stringify(serializedSuggestions)}`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: AUDIT_MAX_TOKENS,
      },
      {
        timeout: AUDIT_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      return { results: [] };
    }

    const parsed = JSON.parse(rawContent) as unknown;

    if (!isAuditResponse(parsed)) {
      return { results: [] };
    }

    return parsed;
  } catch {
    return { results: [] };
  }
}
