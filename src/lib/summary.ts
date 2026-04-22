import { getGroqClient } from "@/lib/groq-client";
import type { RollingSummary } from "@/lib/types";

const SUMMARY_MODEL = "llama-3.1-8b-instant";
const SUMMARY_TIMEOUT_MS = 15_000;
const SUMMARY_MAX_TOKENS = 300;
const SUMMARY_INPUT_MAX_CHARS = 4000;

const SUMMARY_PHASES = new Set(["exploring", "converging", "deciding", "wrapping", "unclear"]);
const SUMMARY_TONES = new Set([
  "analytical",
  "tense",
  "aligned",
  "stalled",
  "exploratory",
  "neutral",
]);

const SUMMARY_SYSTEM_PROMPT = `You maintain a rolling narrative summary of a live meeting. Focus on the ARC, not individual facts (facts live elsewhere).

Output ONLY these fields: topic, stance, phase, tone, participants_heard.
- topic: what the conversation is ABOUT right now (not what's been said — what's the thread)
- stance: where the group is leaning, if anywhere
- phase: one of [exploring, converging, deciding, wrapping, unclear]
- tone: one of [analytical, tense, aligned, stalled, exploratory, neutral]
- participants_heard: distinct voice labels if discernible (names, roles, or "Speaker 1/2"); empty array if not

Never invent content. If unclear, use "unclear" for phase and "neutral" for tone.`;

const truncateTranscript = (value: string) => {
  const normalized = value.trim();

  if (normalized.length <= SUMMARY_INPUT_MAX_CHARS) {
    return normalized;
  }

  return normalized.slice(-SUMMARY_INPUT_MAX_CHARS);
};

const isRollingSummary = (value: unknown): value is RollingSummary => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.topic === "string" &&
    candidate.topic.trim().length > 0 &&
    typeof candidate.stance === "string" &&
    candidate.stance.trim().length > 0 &&
    typeof candidate.phase === "string" &&
    SUMMARY_PHASES.has(candidate.phase) &&
    typeof candidate.tone === "string" &&
    SUMMARY_TONES.has(candidate.tone) &&
    Array.isArray(candidate.participants_heard) &&
    candidate.participants_heard.length <= 5 &&
    candidate.participants_heard.every((participant) => typeof participant === "string")
  );
};

export const updateRollingSummary = async (fullTranscript: string): Promise<RollingSummary | null> => {
  const transcriptBlock = truncateTranscript(fullTranscript);

  if (!transcriptBlock) {
    return null;
  }

  const client = getGroqClient();
  const userPrompt = `FULL RUNNING COMMITTED TRANSCRIPT:
${transcriptBlock}`;

  try {
    const completion = await client.chat.completions.create(
      {
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: SUMMARY_MAX_TOKENS,
      },
      {
        timeout: SUMMARY_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      return null;
    }

    const parsed = JSON.parse(rawContent) as unknown;

    return isRollingSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
