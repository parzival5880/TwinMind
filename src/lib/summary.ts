import Groq from "groq-sdk";
import { getGroqClient } from "@/lib/groq-client";
import type { TranscriptChunk } from "@/lib/types";

// Summary is generated with a smaller, much faster Groq model. The goal is not
// eloquence — it is a compact semantic memory that preserves facts and open
// questions so the 120B suggestion model can focus its context budget on the
// verbatim recent window.
const SUMMARY_MODEL = "llama-3.1-8b-instant";
const SUMMARY_TIMEOUT_MS = 15_000;
const SUMMARY_MAX_WORDS = 120;
const SUMMARY_MAX_TOKENS = 260;

export type SummaryChunkInput = {
  timestamp: string;
  text: string;
  speaker?: string;
};

const buildChunkBlock = (chunks: SummaryChunkInput[]) =>
  chunks
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";

      return `[${chunk.timestamp}] ${speakerLabel}${chunk.text.trim()}`;
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");

const SUMMARY_SYSTEM_PROMPT = `You update a running summary of a live meeting.

RULES:
- Preserve: key decisions, open questions, named entities (people, products, vendors, tools), specific numbers, dates, and commitments.
- Drop: filler, pleasantries, hedging, and restatements.
- Merge new content into the existing summary — do not append a new section.
- Stay in third person, present tense, neutral tone.
- Max ${SUMMARY_MAX_WORDS} words total.
- Return the updated summary text only. No preamble. No markdown headings.`;

const toSummaryInput = (chunks: TranscriptChunk[]): SummaryChunkInput[] =>
  chunks.map((chunk) => ({
    timestamp: chunk.timestamp instanceof Date ? chunk.timestamp.toISOString() : chunk.timestamp,
    text: chunk.text,
    speaker: chunk.speaker,
  }));

export const updateRollingSummary = async (
  existingSummary: string,
  newChunks: TranscriptChunk[] | SummaryChunkInput[],
): Promise<string> => {
  if (!newChunks || newChunks.length === 0) {
    return existingSummary.trim();
  }

  const normalizedChunks: SummaryChunkInput[] =
    (newChunks as TranscriptChunk[])[0]?.timestamp instanceof Date
      ? toSummaryInput(newChunks as TranscriptChunk[])
      : (newChunks as SummaryChunkInput[]);

  const chunkBlock = buildChunkBlock(normalizedChunks);

  if (chunkBlock.length === 0) {
    return existingSummary.trim();
  }

  const client = getGroqClient();
  const trimmedExisting = existingSummary.trim();
  const userPrompt = `EXISTING SUMMARY:
${trimmedExisting || "(no prior summary yet)"}

NEW TRANSCRIPT CONTENT TO INCORPORATE:
${chunkBlock}

Return the single updated summary. No preamble.`;

  try {
    const completion = await client.chat.completions.create(
      {
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: SUMMARY_MAX_TOKENS,
      },
      {
        timeout: SUMMARY_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const next = completion.choices[0]?.message?.content?.trim();

    if (!next) {
      return trimmedExisting;
    }

    return next;
  } catch (error) {
    // Summary is a best-effort enrichment. If the small model fails, we keep
    // the prior summary rather than breaking suggestion generation.
    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      return trimmedExisting;
    }

    return trimmedExisting;
  }
};
