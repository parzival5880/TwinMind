import Groq from "groq-sdk";
import { validateGroqApiKey } from "@/lib/groq-client";

const CLASSIFIER_MODEL = "llama-3.1-8b-instant";
const CLASSIFIER_TIMEOUT_MS = 8_000;
const CLASSIFIER_MAX_TOKENS = 60;
const CLASSIFIER_INPUT_MAX_CHARS = 3000;
const MEETING_TYPES = [
  "sales_call",
  "interview",
  "technical_review",
  "standup",
  "brainstorm",
  "planning",
  "one_on_one",
  "default",
] as const;

type MeetingType = (typeof MEETING_TYPES)[number];

type ClassificationResponse = {
  meeting_type: MeetingType;
  confidence: number;
};

const truncateTranscript = (transcript: string) => transcript.trim().slice(0, CLASSIFIER_INPUT_MAX_CHARS);

const isClassificationResponse = (value: unknown): value is ClassificationResponse => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.meeting_type === "string" &&
    MEETING_TYPES.includes(candidate.meeting_type as MeetingType) &&
    typeof candidate.confidence === "number" &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1
  );
};

export async function classifyMeeting(
  apiKey: string,
  transcript: string,
): Promise<{ meeting_type: string; confidence: number }> {
  const trimmedTranscript = truncateTranscript(transcript);

  if (!trimmedTranscript) {
    return { meeting_type: "default", confidence: 0 };
  }

  try {
    const client = new Groq({
      apiKey: validateGroqApiKey(apiKey),
      dangerouslyAllowBrowser: false,
      maxRetries: 0,
      timeout: CLASSIFIER_TIMEOUT_MS,
    });

    const completion = await client.chat.completions.create(
      {
        model: CLASSIFIER_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Classify the meeting transcript into exactly one meeting_type. Return strict JSON with meeting_type and confidence only.",
          },
          {
            role: "user",
            content: `Valid meeting_type values: ${MEETING_TYPES.join(", ")}.

Transcript:
${trimmedTranscript}`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: CLASSIFIER_MAX_TOKENS,
      },
      {
        timeout: CLASSIFIER_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      return { meeting_type: "default", confidence: 0 };
    }

    const parsed = JSON.parse(rawContent) as unknown;

    if (!isClassificationResponse(parsed)) {
      return { meeting_type: "default", confidence: 0 };
    }

    return parsed;
  } catch {
    return { meeting_type: "default", confidence: 0 };
  }
}
