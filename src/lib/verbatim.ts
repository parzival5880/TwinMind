import { isLargeModelExpandedContext } from "@/lib/llm-clients";
import type { TranscriptChunk } from "@/lib/types";

const VERBATIM_WINDOW_MS_TIGHT = 90_000;
const VERBATIM_WINDOW_MS_EXPANDED = 120_000;
const VERBATIM_MAX_CHARS_TIGHT = 1600;
const VERBATIM_MAX_CHARS_EXPANDED = 3200;

const buildTranscriptString = (transcript: TranscriptChunk[]) =>
  transcript
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";

      return `[${chunk.timestamp.toISOString()}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

export const buildVerbatimRecent = (transcript: TranscriptChunk[]) => {
  if (transcript.length === 0) {
    return "";
  }

  const expanded = isLargeModelExpandedContext();
  const windowMs = expanded ? VERBATIM_WINDOW_MS_EXPANDED : VERBATIM_WINDOW_MS_TIGHT;
  const maxChars = expanded ? VERBATIM_MAX_CHARS_EXPANDED : VERBATIM_MAX_CHARS_TIGHT;

  const newest = transcript[transcript.length - 1];
  const cutoffTime = newest.timestamp.getTime() - windowMs;
  const recent = transcript.filter((chunk) => chunk.timestamp.getTime() >= cutoffTime);
  const chunksToUse = recent.length > 0 ? recent : transcript.slice(-3);

  let verbatim = buildTranscriptString(chunksToUse);

  verbatim = verbatim.replace(/\b(um|uh|uhh|erm|hmm)\b[,.\s]?/gi, " ");
  verbatim = verbatim.replace(/\b(you know|i mean|kind of|sort of)\b/gi, "");
  verbatim = verbatim.replace(/ {2,}/g, " ").trim();

  if (verbatim.length > maxChars) {
    verbatim = "\u2026" + verbatim.slice(-maxChars);
  }

  return verbatim;
};
