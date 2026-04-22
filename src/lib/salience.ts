import Groq from "groq-sdk";
import type {
  SalienceExtractionRaw,
  SalienceExtractionRequest,
  SalienceExtractionResponse,
} from "@/lib/types";

const SALIENCE_MODEL = "llama-3.1-8b-instant";
const SALIENCE_TIMEOUT_MS = 15_000;
const MIN_SLICE_LENGTH = 40;
const MAX_NEW_MOMENTS = 4;
const MAX_SUMMARY_WORDS = 15;
const MAX_VERBATIM_WORDS = 25;

const EMPTY_RESPONSE: SalienceExtractionResponse = {
  new_moments: [],
  resolved_ids: [],
};

const SYSTEM_PROMPT = `You extract salient moments from a live meeting transcript.

Categories (choose ONE per moment):
- claim: a factual assertion, often with numbers/metrics
- question: an open question raised but not yet answered
- decision: a choice or commitment the group has made
- commitment: a personal promise to do something
- objection: a concern or pushback raised
- key_entity: a person, company, or technology being discussed at length

Rules:
- Return STRICT JSON matching the schema. No prose.
- If nothing in the transcript is clearly salient, return empty arrays.
- NEVER invent content. Every \`verbatim\` string MUST be a literal (case-insensitive) substring of the provided transcript slice.
- \`verbatim\` ≤ 25 words. \`summary\` ≤ 15 words, your own paraphrase.
- \`importance\`: integer 3 (notable), 4 (significant), 5 (critical — numbers, decisions, major claims). Never emit 1 or 2.
- Resolution: mark an open moment as resolved ONLY if the new transcript explicitly answers a \`question\` or confirms a \`commitment\` is met. Do NOT mark \`claim\`, \`decision\`, \`objection\`, or \`key_entity\` as resolved via this endpoint.
- Output maximum 4 new_moments per call.`;

const trimToWordLimit = (text: string, limit: number) => {
  const words = text.trim().split(/\s+/);
  return words.length <= limit ? text.trim() : words.slice(0, limit).join(" ");
};

const clampImportance = (value: number): 3 | 4 | 5 => {
  const rounded = Math.round(value);
  if (rounded >= 5) return 5;
  if (rounded >= 4) return 4;
  return 3;
};

export async function extractSalience(
  apiKey: string,
  req: SalienceExtractionRequest,
): Promise<SalienceExtractionResponse> {
  const trimmedSlice = req.transcript_slice?.trim() ?? "";

  if (trimmedSlice.length < MIN_SLICE_LENGTH) {
    return EMPTY_RESPONSE;
  }

  try {
    const client = new Groq({ apiKey, dangerouslyAllowBrowser: false });

    const openMomentsCompact = req.open_moments.map(({ id, category, summary }) => ({
      id,
      category,
      summary,
    }));

    const userPrompt = `Open moments (may be empty):
${JSON.stringify(openMomentsCompact)}

New transcript slice:
${trimmedSlice}

Return the JSON now.`;

    const completion = await client.chat.completions.create(
      {
        model: SALIENCE_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 450,
        response_format: { type: "json_object" },
      },
      {
        timeout: SALIENCE_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      console.warn("[salience] extraction failed: empty model response");
      return EMPTY_RESPONSE;
    }

    const parsed = JSON.parse(rawContent) as SalienceExtractionRaw;
    const sliceLower = trimmedSlice.toLowerCase();
    const openIds = new Set(req.open_moments.map((m) => m.id));

    const validatedMoments = (parsed.new_moments ?? [])
      .slice(0, MAX_NEW_MOMENTS)
      .filter((m) => sliceLower.includes(m.verbatim.trim().toLowerCase()))
      .map((m) => ({
        category: m.category,
        summary: trimToWordLimit(m.summary, MAX_SUMMARY_WORDS),
        verbatim: trimToWordLimit(m.verbatim, MAX_VERBATIM_WORDS),
        importance: clampImportance(m.importance),
      }));

    const validatedResolved = (parsed.resolved_ids ?? []).filter((id) => openIds.has(id));

    return {
      new_moments: validatedMoments,
      resolved_ids: validatedResolved,
    };
  } catch (error) {
    console.warn(
      "[salience] extraction failed:",
      error instanceof Error ? error.message : String(error),
    );
    return EMPTY_RESPONSE;
  }
}
