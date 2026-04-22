import OpenAI from "openai";
import Groq from "groq-sdk";
import {
  getLargeModelClient,
  getLargeModelName,
  isLargeModelExpandedContext,
} from "@/lib/llm-clients";
import {
  buildChatSystemPrompt,
  DEFAULT_CONTEXT_WINDOWS,
  buildSuggestionsPrompt,
} from "@/lib/prompts";
import type {
  ChatRequest,
  ChatMessage,
  Suggestion,
  SuggestionConviction,
  SuggestionMeta,
  SuggestionsRequest,
} from "@/lib/types";

const GROQ_KEY_PREFIX = "gsk_";
const MIN_GROQ_KEY_LENGTH = 24;
const GROQ_TRANSCRIPTION_TIMEOUT_MS = 15_000;
// Single budget covering the primary completion AND the in-line type-mix
// retry. The retry shares the same client, so one timeout spans both.
const GROQ_SUGGESTIONS_TIMEOUT_MS_STANDARD = 12_000;
const GROQ_SUGGESTIONS_TIMEOUT_MS_EXPANDED = 35_000;
const GROQ_CHAT_TIMEOUT_MS_STANDARD = 25_000;
const GROQ_CHAT_TIMEOUT_MS_EXPANDED = 45_000;
const GROQ_KEY_VALIDATION_TIMEOUT_MS = 10_000;

function getChatTimeoutMs(): number {
  return isLargeModelExpandedContext()
    ? GROQ_CHAT_TIMEOUT_MS_EXPANDED
    : GROQ_CHAT_TIMEOUT_MS_STANDARD;
}

function getSuggestionsTimeoutMs(): number {
  return isLargeModelExpandedContext()
    ? GROQ_SUGGESTIONS_TIMEOUT_MS_EXPANDED
    : GROQ_SUGGESTIONS_TIMEOUT_MS_STANDARD;
}
const WHISPER_MODEL = "whisper-large-v3";
export const SUGGESTION_TYPES = [
  "question",
  "talking_point",
  "answer",
  "fact_check",
  "clarification",
] as const;

export { getSuggestionsTimeoutMs };

let groqClient: Groq | null = null;

export class APIKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "APIKeyError";
  }
}

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class SuggestionGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestionGenerationError";
  }
}

export class ChatGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGenerationError";
  }
}

export const validateGroqApiKey = (apiKey: string) => {
  const normalizedApiKey = apiKey.trim();

  if (!normalizedApiKey) {
    throw new APIKeyError("A Groq API key is required.");
  }

  if (!normalizedApiKey.startsWith(GROQ_KEY_PREFIX)) {
    throw new APIKeyError(
      'Groq API keys should start with "gsk_". Check the key you pasted and try again.',
    );
  }

  if (normalizedApiKey.length < MIN_GROQ_KEY_LENGTH) {
    throw new APIKeyError(
      "That Groq API key looks incomplete. Paste the full key from the Groq console.",
    );
  }

  return normalizedApiKey;
};

export const initializeGroqClient = (apiKey: string) => {
  const normalizedApiKey = validateGroqApiKey(apiKey);

  groqClient = new Groq({
    apiKey: normalizedApiKey,
    dangerouslyAllowBrowser: typeof window !== "undefined",
  });

  return groqClient;
};

export const getGroqClient = () => {
  if (!groqClient) {
    throw new APIKeyError("The Groq client has not been initialized yet.");
  }

  return groqClient;
};

export const isClientInitialized = () => groqClient !== null;

export const clearGroqClient = () => {
  groqClient = null;
};

export const testGroqApiKey = async (apiKey: string): Promise<void> => {
  const normalizedApiKey = validateGroqApiKey(apiKey);
  const validationClient = new Groq({
    apiKey: normalizedApiKey,
    dangerouslyAllowBrowser: typeof window !== "undefined",
    maxRetries: 0,
    timeout: GROQ_KEY_VALIDATION_TIMEOUT_MS,
  });

  try {
    await validationClient.models.list({
      timeout: GROQ_KEY_VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    });
  } catch (error) {
    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the configured key and try again.");
    }

    if (error instanceof Groq.APIConnectionTimeoutError) {
      throw new TimeoutError("Groq API key validation timed out. Try again in a moment.");
    }

    if (error instanceof Error) {
      throw new APIKeyError(error.message || "Unable to validate the Groq API key.");
    }

    throw new APIKeyError("Unable to validate the Groq API key.");
  }
};

const getAudioMimeType = (audioBlob: Blob) => audioBlob.type || "audio/webm";

const buildAudioFilename = (audioBlob: Blob) => {
  const mimeType = getAudioMimeType(audioBlob);
  const rawExtension = mimeType.split("/")[1] ?? "webm";
  const extension = rawExtension.split(";")[0] ?? "webm";

  return `recording.${extension}`;
};

export function extractAssistantText(
  msg: { content?: string | null; reasoning_content?: string | null } | undefined,
): string {
  const primary = (msg?.content ?? "").trim();

  if (primary) {
    return primary;
  }

  const reasoning = ((msg as { reasoning_content?: string | null } | undefined)?.reasoning_content ?? "")
    .trim();

  return reasoning;
}

export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);

  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    return raw.slice(first, last + 1);
  }

  return raw.trim();
}

export type TranscriptionResult = {
  text: string;
  startMs: number | undefined;
  endMs: number | undefined;
};

type WhisperWord = {
  word: string;
  start: number;
  end: number;
};

type WhisperVerboseResponse = {
  text: string;
  words?: WhisperWord[];
};

export const transcribeAudio = async (
  audioBlob: Blob,
  options?: {
    prompt?: string;
  },
): Promise<TranscriptionResult> => {
  if (!audioBlob || audioBlob.size === 0) {
    throw new TranscriptionError("Audio data is required for transcription.");
  }

  const client = getGroqClient();

  try {
    const transcription = (await client.audio.transcriptions.create(
      {
        file: await Groq.toFile(audioBlob, buildAudioFilename(audioBlob), {
          type: getAudioMimeType(audioBlob),
        }),
        language: "en",
        model: WHISPER_MODEL,
        prompt: options?.prompt?.trim() || undefined,
        response_format: "verbose_json",
        temperature: 0,
        timestamp_granularities: ["word"],
      },
      {
        timeout: GROQ_TRANSCRIPTION_TIMEOUT_MS,
        maxRetries: 0,
      },
    )) as unknown as WhisperVerboseResponse;

    const text = transcription.text.trim();
    const words = transcription.words;
    let startMs: number | undefined;
    let endMs: number | undefined;

    if (words && words.length > 0) {
      startMs = Math.round(words[0].start * 1000);
      endMs = Math.round(words[words.length - 1].end * 1000);
    }

    return { text, startMs, endMs };
  } catch (error) {
    if (error instanceof APIKeyError || error instanceof TimeoutError) {
      throw error;
    }

    if (error instanceof Groq.AuthenticationError) {
      throw new APIKeyError("The Groq API key was rejected. Check the configured key and try again.");
    }

    if (error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key does not have permission to transcribe audio.");
    }

    if (error instanceof Groq.APIConnectionTimeoutError) {
      throw new TimeoutError("Groq transcription timed out after 15 seconds.");
    }

    if (error instanceof Groq.BadRequestError) {
      throw new TranscriptionError("Groq could not process this audio chunk.");
    }

    if (error instanceof Error) {
      throw new TranscriptionError(error.message || "Groq transcription failed.");
    }

    throw new TranscriptionError("Groq transcription failed.");
  }
};

const countWords = (value: string) =>
  value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const SUGGESTION_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "about",
  "from",
  "into",
  "if",
  "then",
  "so",
  "than",
  "too",
  "very",
  "not",
  "no",
  "you",
  "your",
  "their",
  "them",
  "they",
  "we",
  "our",
  "us",
]);

const tokenizeSuggestionText = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !SUGGESTION_STOPWORDS.has(token)),
  );

const jaccardSimilarity = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }

  let intersectionCount = 0;

  a.forEach((token) => {
    if (b.has(token)) {
      intersectionCount += 1;
    }
  });

  const unionCount = a.size + b.size - intersectionCount;

  if (unionCount === 0) {
    return 0;
  }

  return intersectionCount / unionCount;
};

export const normalizeSuggestion = (
  suggestion: Omit<Suggestion, "id">,
  index: number,
): Suggestion => ({
  id: `generated-${index + 1}`,
  type: suggestion.type,
  conviction: suggestion.conviction === "medium" ? "medium" : "high",
  preview: suggestion.preview.trim(),
  full_content: suggestion.full_content.trim(),
  evidence_quote: suggestion.evidence_quote.trim(),
  rationale: suggestion.rationale.trim(),
  why_relevant: suggestion.why_relevant.trim(),
  source_url: suggestion.source_url?.trim() || undefined,
  source_title: suggestion.source_title?.trim() || undefined,
  source_scope: suggestion.source_scope?.trim() || undefined,
  trigger: suggestion.trigger?.trim() || undefined,
  selection_reason: suggestion.selection_reason?.trim() || undefined,
});

const normalizeConviction = (value: unknown): SuggestionConviction =>
  value === "medium" || value === "high" ? value : "high";

const MISSING_EVIDENCE_QUOTE_PLACEHOLDER = "(no quote captured)";
const MISSING_RATIONALE_PLACEHOLDER = "(model didn't provide rationale)";

const clampFullContentToSentenceLimit = (fullContent: string, maxWords: number) => {
  const normalized = fullContent.trim();
  const sentences = normalized.match(/[^.!?…]+[.!?…]["')\]]*\s*/g);

  if (sentences && sentences.length > 0) {
    const keptSentences: string[] = [];
    let runningWords = 0;

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      const sentenceWordCount = countWords(trimmedSentence);

      if (keptSentences.length > 0 && runningWords + sentenceWordCount > maxWords) {
        break;
      }

      keptSentences.push(trimmedSentence);
      runningWords += sentenceWordCount;

      if (runningWords >= maxWords) {
        break;
      }
    }

    if (keptSentences.length > 0) {
      return keptSentences.join(" ").trim();
    }
  }

  return normalized.split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ").trim();
};

export const validateSuggestions = (
  suggestions: Suggestion[],
  verbatimRecent?: string,
  allowedUrls: Set<string> = new Set(),
  groundedFactsByUrl?: Map<string, { entity: string; fact: string; scope: string }>,
) => {
  if (suggestions.length !== 3) {
    throw new SuggestionGenerationError("Expected exactly 3 suggestions from the model.");
  }

  const uniqueTypes = new Set<Suggestion["type"]>();
  const uniqueFingerprints = new Set<string>();
  const normalizedVerbatim = verbatimRecent?.trim().toLowerCase() || "";
  const validSuggestions: Suggestion[] = [];

  suggestions.forEach((suggestion) => {
    if (!SUGGESTION_TYPES.includes(suggestion.type)) {
      throw new SuggestionGenerationError("Suggestion type validation failed.");
    }

    const previewWordCount = countWords(suggestion.preview);

    // Preview target is ≤25 words but we allow up to 40 before rejecting to
    // avoid spurious retries on borderline responses.
    if (previewWordCount === 0 || previewWordCount > 40) {
      throw new SuggestionGenerationError("Suggestion preview length validation failed.");
    }

    let normalizedFullContent = suggestion.full_content.trim();
    let fullContentWordCount = countWords(normalizedFullContent);

    if (fullContentWordCount < 25) {
      console.warn("[TwinMind][suggestions][validator] dropping short full_content", {
        suggestion_id: suggestion.id,
        word_count: fullContentWordCount,
      });
      return;
    }

    if (fullContentWordCount > 200) {
      normalizedFullContent = clampFullContentToSentenceLimit(normalizedFullContent, 200);
      fullContentWordCount = countWords(normalizedFullContent);
      console.warn("[TwinMind][suggestions][validator] truncating long full_content", {
        suggestion_id: suggestion.id,
        truncated_word_count: fullContentWordCount,
        original_word_count: countWords(suggestion.full_content),
      });
    }

    // evidence_quote: non-empty, ≤15 words, must appear in verbatim_recent.
    let quoteText = suggestion.evidence_quote.trim();

    if (!quoteText) {
      quoteText = MISSING_EVIDENCE_QUOTE_PLACEHOLDER;
      console.warn("[TwinMind][suggestions][validator] missing evidence_quote", {
        suggestion_id: suggestion.id,
      });
    }

    if (
      quoteText !== MISSING_EVIDENCE_QUOTE_PLACEHOLDER &&
      countWords(quoteText) > 15
    ) {
      // Truncate gracefully instead of dropping the whole batch.
      quoteText = quoteText.split(/\s+/).slice(0, 15).join(" ");
      console.warn("[TwinMind][suggestions][validator] truncating long evidence_quote", {
        suggestion_id: suggestion.id,
        truncated: quoteText,
      });
    }

    if (
      quoteText !== MISSING_EVIDENCE_QUOTE_PLACEHOLDER &&
      normalizedVerbatim &&
      !normalizedVerbatim.includes(quoteText.toLowerCase())
    ) {
      return;
    }

    let rationale = suggestion.rationale.trim();

    if (!rationale) {
      rationale = MISSING_RATIONALE_PLACEHOLDER;
      console.warn("[TwinMind][suggestions][validator] missing rationale", {
        suggestion_id: suggestion.id,
      });
    }

    if (rationale.length > 240) {
      rationale = `${rationale.slice(0, 237).replace(/\s+\S*$/, "")}...`;
      console.warn("[TwinMind][suggestions][validator] truncating long rationale", {
        suggestion_id: suggestion.id,
      });
    }

    let whyRelevant = suggestion.why_relevant.trim();

    if (!whyRelevant) {
      throw new SuggestionGenerationError("Suggestion why_relevant must be non-empty.");
    }

    if (whyRelevant.length > 150) {
      // Truncate at word boundary instead of dropping the whole batch.
      whyRelevant = whyRelevant.slice(0, 147).replace(/\s+\S*$/, "") + "...";
      console.warn("[TwinMind][suggestions][validator] truncating long why_relevant", {
        suggestion_id: suggestion.id,
      });
    }

    const previewTokens = tokenizeSuggestionText(suggestion.preview);
    const whyRelevantTokens = tokenizeSuggestionText(whyRelevant);

    if (jaccardSimilarity(previewTokens, whyRelevantTokens) > 0.8) {
      throw new SuggestionGenerationError(
        "why_relevant restates preview; must explain linkage to evidence_quote",
      );
    }

    const sourceUrl = suggestion.source_url?.trim() || "";
    const sourceRequiredByType = suggestion.type === "fact_check";
    const numericPattern = /\b\d+[\s]*(mAh|Wh|W|V|GB|TB|ms|%|\$|£|€)\b/i;
    const properNounNumberPattern =
      /(?:\b[A-Z][a-zA-Z0-9-]+\b.{0,24}\b\d{2,}(?:\.\d+)?\b|\b\d{2,}(?:\.\d+)?\b.{0,24}\b[A-Z][a-zA-Z0-9-]+\b)/;
    const combinedText = `${suggestion.preview} ${normalizedFullContent}`;
    const sourceRequiredByContent =
      numericPattern.test(combinedText) || properNounNumberPattern.test(combinedText);

    if (sourceUrl && !allowedUrls.has(sourceUrl)) {
      console.info("[validator] rejected card", {
        reason: "source_url_not_allowed",
        card: suggestion,
      });
      return;
    }

    if ((sourceRequiredByType || sourceRequiredByContent) && !sourceUrl) {
      console.info("[validator] rejected card", {
        reason: sourceRequiredByType ? "fact_check_missing_source_url" : "numeric_claim_missing_source_url",
        card: suggestion,
      });
      return;
    }

    if (sourceUrl && groundedFactsByUrl?.has(sourceUrl)) {
      const groundedFact = groundedFactsByUrl.get(sourceUrl);
      const numberOrRangeTokens = [
        ...(groundedFact?.scope.match(/\b\d+(?:\.\d+)?(?:[kKmMbB])?\b/g) ?? []),
        ...(groundedFact?.fact.match(/\b\d+(?:\.\d+)?(?:[kKmMbB])?\b/g) ?? []),
      ];
      const properNounTokens = [
        groundedFact?.entity ?? "",
        ...((groundedFact?.scope.match(/\b[A-Z][a-zA-Z0-9-]+\b/g) ?? [])),
        ...((groundedFact?.fact.match(/\b[A-Z][a-zA-Z0-9-]+\b/g) ?? [])),
      ]
        .map((token) => token.trim())
        .filter(Boolean);

      const hasScopedSignal = [...numberOrRangeTokens, ...properNounTokens].some((token) =>
        combinedText.toLowerCase().includes(token.toLowerCase()),
      );

      if (!hasScopedSignal) {
        console.warn("[validator] grounded card looks generic relative to scope", {
          suggestion_id: suggestion.id,
          scope: groundedFact?.scope,
          source_url: sourceUrl,
        });
      }
    }

    const fingerprint = `${suggestion.type}::${suggestion.preview.toLowerCase()}::${suggestion.full_content.toLowerCase()}`;

    if (uniqueFingerprints.has(fingerprint)) {
      throw new SuggestionGenerationError("Duplicate suggestions were generated.");
    }

    uniqueTypes.add(suggestion.type);
    uniqueFingerprints.add(fingerprint);
    validSuggestions.push({
      ...suggestion,
      conviction: normalizeConviction(suggestion.conviction),
      evidence_quote: quoteText,
      full_content: normalizedFullContent,
      rationale,
      source_url: sourceUrl || undefined,
      source_scope: suggestion.source_scope,
    });
  });

  if (validSuggestions.length === 0) {
    throw new SuggestionGenerationError(
      "All suggestions failed word-count validation (target 70-140 words).",
    );
  }

  if (validSuggestions.length > 1 && uniqueTypes.size < 2) {
    throw new SuggestionGenerationError("Suggestion type mix validation failed.");
  }

  return validSuggestions;
};

type SuggestionsSchemaResponse = {
  meta: SuggestionMeta;
  suggestions: Array<{
    type: Suggestion["type"];
    conviction?: SuggestionConviction;
    preview: string;
    full_content: string;
    evidence_quote: string;
    rationale: string;
    why_relevant: string;
    source_url?: string;
    trigger: string;
  }>;
};

const suggestionsResponseSchema = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        meeting_type: { type: "string" },
        conversation_stage: { type: "string" },
      },
      required: ["meeting_type", "conversation_stage"],
      additionalProperties: false,
    },
    suggestions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [...SUGGESTION_TYPES],
          },
          conviction: {
            type: "string",
            enum: ["high", "medium"],
          },
          preview: { type: "string" },
          full_content: { type: "string" },
          evidence_quote: { type: "string", minLength: 1, maxLength: 120 },
          rationale: { type: "string", minLength: 1, maxLength: 240 },
          why_relevant: { type: "string", minLength: 10, maxLength: 150 },
          source_url: { type: "string" },
          trigger: { type: "string" },
        },
        required: [
          "type",
          "preview",
          "full_content",
          "evidence_quote",
          "rationale",
          "why_relevant",
          "trigger",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["meta", "suggestions"],
  additionalProperties: false,
} as const;

export type GenerateSuggestionsResult = {
  suggestions: Suggestion[];
  meta: SuggestionMeta;
};

export const generateSuggestions = async (
  apiKey: string,
  {
    avoid_phrases,
    conversation_stage,
    full_transcript,
    meeting_type,
    recent_chat_topics,
    rolling_summary,
    transcript_chunk,
    verbatim_recent,
  }: SuggestionsRequest,
  salientMemoryRendered?: string,
): Promise<GenerateSuggestionsResult> => {
  const client = getLargeModelClient(apiKey);
  const providerMode =
    process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY
      ? "azure-foundry-models"
      : "groq-fallback";
  const { prompt } = buildSuggestionsPrompt({
    contextWindow: DEFAULT_CONTEXT_WINDOWS.suggestions,
    fullTranscript: full_transcript,
    verbatimRecent: verbatim_recent,
    rollingSummary: rolling_summary,
    recentChatTopics: recent_chat_topics,
    avoidPhrases: avoid_phrases,
    transcriptChunk: transcript_chunk,
    meetingType: meeting_type,
    conversationStage: conversation_stage,
    salientMemoryRendered,
  });

  const systemMessage = {
    role: "system" as const,
    content:
      "You are TwinMind, a real-time meeting copilot. Generate fresh, transcript-grounded meeting suggestions that are immediately useful and do not repeat prior ideas. Never fabricate facts, vendor details, pricing, or answers to unresolved questions.",
  };
  const userMessage = { role: "user" as const, content: prompt };
  const baseMessages = [systemMessage, userMessage];
  const suggestionsMaxTokens = isLargeModelExpandedContext() ? 5000 : 1500;

  const attemptGeneration = async (
    messages: Array<{ role: "system" | "user"; content: string }>,
  ): Promise<GenerateSuggestionsResult> => {
    const completion = await client.chat.completions.create(
      {
        model: getLargeModelName(),
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "meeting_suggestions",
            strict: true,
            schema: suggestionsResponseSchema,
          },
        },
        temperature: 0.6,
        top_p: 0.9,
        max_tokens: suggestionsMaxTokens,
        stop: null,
      },
      {
        timeout: getSuggestionsTimeoutMs(),
        maxRetries: 0,
      },
    );

    const rawContent = extractAssistantText(completion.choices[0]?.message);

    if (!rawContent) {
      throw new SuggestionGenerationError("Failed to parse suggestions from model output.");
    }

    const parsedContent = JSON.parse(extractJsonObject(rawContent)) as SuggestionsSchemaResponse;
    const suggestions = parsedContent.suggestions.map((suggestion, index) =>
      normalizeSuggestion(suggestion, index),
    );
    const validatedSuggestions = validateSuggestions(suggestions, verbatim_recent);

    const meta: SuggestionMeta = {
      meeting_type: parsedContent.meta?.meeting_type?.trim() || "unspecified",
      conversation_stage: parsedContent.meta?.conversation_stage?.trim() || "unspecified",
    };

    return { suggestions: validatedSuggestions, meta };
  };

  try {
    try {
      return await attemptGeneration(baseMessages);
    } catch (firstError) {
      if (
        firstError instanceof SuggestionGenerationError &&
        firstError.message.includes("type mix")
      ) {
        console.warn("[TwinMind][suggestions] type-mix violation detected, retrying once");
        console.info("[suggestions] type-mix retry fired", {
          firstErrorMessage: firstError.message,
          modelName: getLargeModelName(),
          expandedContext: isLargeModelExpandedContext(),
        });
        try {
          return await attemptGeneration([
            ...baseMessages,
            {
              role: "user",
              content:
                "Your previous attempt returned suggestions that collapsed to one type. Regenerate with at least 2 distinct types chosen from { question, talking_point, answer, fact_check, clarification }. Pick types that reflect what the transcript actually calls for: use 'answer' or 'fact_check' only when the transcript contains a specific answerable question or verifiable claim; use 'clarification' when language is genuinely ambiguous; default to 'question' + 'talking_point' otherwise. Return the same strict JSON schema.",
            },
          ]);
        } catch (retryError) {
          if (
            retryError instanceof SuggestionGenerationError &&
            retryError.message.includes("type mix")
          ) {
            throw new SuggestionGenerationError(
              "Suggestion type mix validation failed (after 1 retry).",
            );
          }
          throw retryError;
        }
      }
      throw firstError;
    }
  } catch (error) {
    if (
      error instanceof APIKeyError ||
      error instanceof TimeoutError ||
      error instanceof SuggestionGenerationError
    ) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new SuggestionGenerationError("Failed to parse suggestions from model output.");
    }

    if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
      const typedError = error as {
        body?: unknown;
        error?: unknown;
        headers?: Headers | Record<string, string>;
        message: string;
        name: string;
        request_id?: string | null;
        status?: number;
      };

      console.error("[TwinMind][suggestions][provider-error]", {
        body: typedError.body,
        error: typedError.error,
        headers:
          typedError.headers instanceof Headers
            ? Object.fromEntries(typedError.headers.entries())
            : typedError.headers,
        message: typedError.message,
        name: typedError.name,
        provider_mode: providerMode,
        request_id: typedError.request_id,
        status: typedError.status,
      });
      throw error;
    }

    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the configured key and try again.");
    }

    if (error instanceof Groq.APIConnectionTimeoutError) {
      throw new TimeoutError("Suggestion generation timed out after 8 seconds.");
    }

    if (error instanceof Error) {
      throw new SuggestionGenerationError(error.message || "Failed to generate suggestions.");
    }

    throw new SuggestionGenerationError("Failed to generate suggestions.");
  }
};

const buildChatHistoryContext = (chatHistory: ChatMessage[]) => {
  const recentMessages = chatHistory.slice(-8);

  if (recentMessages.length === 0) {
    return "No prior chat history.";
  }

  return recentMessages
    .map((message) => {
      const timestamp = message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : String(message.timestamp);

      return `[${timestamp}] ${message.role.toUpperCase()}: ${message.content}`;
    })
    .join("\n");
};

const buildDetailedAnswerMessages = (request: ChatRequest) => {
  const chatHistoryContext = buildChatHistoryContext(request.history.slice(-8));
  const trimmedUserMessage = request.message.trim();
  const systemPrompt = buildChatSystemPrompt(request.context, request.suggestion);

  return {
    messages: [
      {
        role: "system" as const,
        content: systemPrompt,
      },
      {
        role: "user" as const,
        content: `RECENT CHAT HISTORY:
${chatHistoryContext}

USER MESSAGE:
${trimmedUserMessage}`,
      },
    ],
  };
};

export const streamDetailedAnswer = async (apiKey: string, request: ChatRequest) => {
  const client = getLargeModelClient(apiKey);
  const { messages } = buildDetailedAnswerMessages(request);
  const chatMaxTokens = isLargeModelExpandedContext() ? 8000 : 2500;

  try {
    return await client.chat.completions.create(
      {
        model: getLargeModelName(),
        messages,
        response_format: {
          type: "text",
        },
        temperature: 0.3,
        max_tokens: chatMaxTokens,
        stream: true,
      },
      {
        timeout: getChatTimeoutMs(),
        maxRetries: 0,
      },
    );
  } catch (error) {
    if (error instanceof APIKeyError || error instanceof TimeoutError || error instanceof ChatGenerationError) {
      throw error;
    }

    if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
      throw error;
    }

    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the configured key and try again.");
    }

    if (error instanceof Groq.APIConnectionTimeoutError) {
      throw new TimeoutError("Detailed answer generation timed out after 25 seconds.");
    }

    if (error instanceof Error) {
      throw new ChatGenerationError(error.message || "Failed to generate a detailed answer.");
    }

    throw new ChatGenerationError("Failed to generate a detailed answer.");
  }
};

export const generateDetailedAnswer = async ({
  apiKey,
  context,
  history,
  message,
  suggestion,
}: ChatRequest & { apiKey: string }): Promise<string> => {
  const client = getLargeModelClient(apiKey);
  const { messages } = buildDetailedAnswerMessages({
    context,
    history,
    message,
    suggestion,
  });
  const chatMaxTokens = isLargeModelExpandedContext() ? 8000 : 2500;

  try {
    const completion = await client.chat.completions.create(
      {
        model: getLargeModelName(),
        messages,
        response_format: {
          type: "text",
        },
        temperature: 0.3,
        max_tokens: chatMaxTokens,
      },
      {
        timeout: getChatTimeoutMs(),
        maxRetries: 0,
      },
    );

    const content = extractAssistantText(completion.choices[0]?.message);

    if (!content) {
      throw new ChatGenerationError("Failed to generate a detailed answer.");
    }

    return content;
  } catch (error) {
    if (error instanceof APIKeyError || error instanceof TimeoutError || error instanceof ChatGenerationError) {
      throw error;
    }

    if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
      throw error;
    }

    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the configured key and try again.");
    }

    if (error instanceof Groq.APIConnectionTimeoutError) {
      throw new TimeoutError("Detailed answer generation timed out after 25 seconds.");
    }

    if (error instanceof Error) {
      throw new ChatGenerationError(error.message || "Failed to generate a detailed answer.");
    }

    throw new ChatGenerationError("Failed to generate a detailed answer.");
  }
};

// ---------------------------------------------------------------------------
// Streaming suggestion generation
//
// Parses a streaming JSON response character-by-character to surface whole
// suggestion objects the moment they complete inside the top-level
// `suggestions: [...]` array. Never parses partial JSON — each element is
// parsed independently with JSON.parse once its brace depth returns to zero.
// ---------------------------------------------------------------------------

type StreamingSuggestionHandlers = {
  onMeta: (meta: {
    batch_id: string;
    generated_at: string;
    meeting_type: string;
    conversation_stage: string;
  }) => void;
  onCard: (suggestion: Suggestion, index: number, options?: { replace?: boolean }) => void;
  onRetrying: (reason: string) => void;
  onDone: (summary: {
    batch_id: string;
    total_cards: number;
    critique_used: boolean;
    retry_fired: boolean;
    meta: SuggestionMeta;
  }) => void;
  onError: (message: string, code: string) => void;
};

type StreamingSuggestionOptions = {
  abortSignal?: AbortSignal;
};

export class SuggestionsStreamParser {
  private buffer = "";
  private cursor = 0;
  private inArray = false;
  private objStart = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private completedElements = 0;
  private readonly arrayKey: string;
  private readonly openPattern: RegExp;

  constructor(arrayKey: string = "suggestions") {
    this.arrayKey = arrayKey;
    const escapedKey = arrayKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.openPattern = new RegExp(`"${escapedKey}"\\s*:\\s*\\[`, "g");
  }

  append(chunk: string): { completedElements: Array<{ raw: string; index: number }> } {
    this.buffer += chunk;
    const completed: Array<{ raw: string; index: number }> = [];

    if (!this.inArray) {
      const arrayOpen = this.findSuggestionsArrayOpen();
      if (arrayOpen === -1) {
        return { completedElements: [] };
      }
      this.inArray = true;
      this.cursor = arrayOpen;
    }

    while (this.cursor < this.buffer.length) {
      const ch = this.buffer[this.cursor];

      if (this.depth === 0) {
        if (ch === "{") {
          this.objStart = this.cursor;
          this.depth = 1;
        } else if (ch === "]") {
          this.cursor += 1;
          break;
        }
        this.cursor += 1;
        continue;
      }

      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (ch === "\\") {
          this.escaped = true;
        } else if (ch === '"') {
          this.inString = false;
        }
      } else if (ch === '"') {
        this.inString = true;
      } else if (ch === "{") {
        this.depth += 1;
      } else if (ch === "}") {
        this.depth -= 1;
        if (this.depth === 0) {
          const raw = this.buffer.slice(this.objStart, this.cursor + 1);
          completed.push({ raw, index: this.completedElements });
          this.completedElements += 1;
          this.objStart = -1;
        }
      }

      this.cursor += 1;
    }

    return { completedElements: completed };
  }

  private findSuggestionsArrayOpen(): number {
    this.openPattern.lastIndex = 0;
    const match = this.openPattern.exec(this.buffer);
    return match ? match.index + match[0].length : -1;
  }
}

type RawStreamedSuggestion = {
  type?: string;
  conviction?: string;
  preview?: string;
  full_content?: string;
  evidence_quote?: string;
  rationale?: string;
  why_relevant?: string;
  source_url?: string;
  trigger?: string;
  selection_reason?: string;
};

export const isValidSuggestionType = (value: unknown): value is Suggestion["type"] =>
  typeof value === "string" && (SUGGESTION_TYPES as readonly string[]).includes(value);

export const coerceStreamedCard = (raw: string, index: number): Suggestion | null => {
  try {
    const parsed = JSON.parse(raw) as RawStreamedSuggestion;
    if (
      !isValidSuggestionType(parsed.type) ||
      typeof parsed.preview !== "string" ||
      typeof parsed.full_content !== "string" ||
      typeof parsed.evidence_quote !== "string" ||
      typeof parsed.rationale !== "string" ||
      typeof parsed.why_relevant !== "string"
    ) {
      return null;
    }

    return normalizeSuggestion(
      {
        type: parsed.type,
        conviction: normalizeConviction(parsed.conviction),
        preview: parsed.preview,
        full_content: parsed.full_content,
        evidence_quote: parsed.evidence_quote,
        rationale: parsed.rationale,
        why_relevant: parsed.why_relevant,
        source_url: parsed.source_url,
        trigger: parsed.trigger,
        selection_reason: parsed.selection_reason,
      },
      index,
    );
  } catch {
    return null;
  }
};

export const generateSuggestionsStreaming = async (
  apiKey: string,
  {
    avoid_phrases,
    conversation_stage,
    full_transcript,
    meeting_type,
    recent_chat_topics,
    rolling_summary,
    transcript_chunk,
    verbatim_recent,
  }: SuggestionsRequest,
  salientMemoryRendered: string | undefined,
  handlers: StreamingSuggestionHandlers,
  options: StreamingSuggestionOptions = {},
): Promise<void> => {
  const client = getLargeModelClient(apiKey);
  const { prompt } = buildSuggestionsPrompt({
    contextWindow: DEFAULT_CONTEXT_WINDOWS.suggestions,
    fullTranscript: full_transcript,
    verbatimRecent: verbatim_recent,
    rollingSummary: rolling_summary,
    recentChatTopics: recent_chat_topics,
    avoidPhrases: avoid_phrases,
    transcriptChunk: transcript_chunk,
    meetingType: meeting_type,
    conversationStage: conversation_stage,
    salientMemoryRendered,
  });

  const systemMessage = {
    role: "system" as const,
    content:
      "You are TwinMind, a real-time meeting copilot. Generate fresh, transcript-grounded meeting suggestions that are immediately useful and do not repeat prior ideas. Never fabricate facts, vendor details, pricing, or answers to unresolved questions.",
  };
  const userMessage = { role: "user" as const, content: prompt };
  const baseMessages: Array<{ role: "system" | "user"; content: string }> = [
    systemMessage,
    userMessage,
  ];
  const suggestionsMaxTokens = isLargeModelExpandedContext() ? 3200 : 1500;

  const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const generatedAt = new Date().toISOString();

  handlers.onMeta({
    batch_id: batchId,
    generated_at: generatedAt,
    meeting_type: meeting_type || "unspecified",
    conversation_stage: conversation_stage || "unspecified",
  });

  type StreamAttemptResult = {
    cards: Suggestion[];
    meta: SuggestionMeta;
  };

  const runStream = async (
    messages: Array<{ role: "system" | "user"; content: string }>,
    onIncrementalCard: (card: Suggestion, index: number) => void,
  ): Promise<StreamAttemptResult> => {
    const completion = await client.chat.completions.create(
      {
        model: getLargeModelName(),
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "meeting_suggestions",
            strict: true,
            schema: suggestionsResponseSchema,
          },
        },
        temperature: 0.6,
        top_p: 0.9,
        max_tokens: suggestionsMaxTokens,
        stream: true,
        stop: null,
      },
      {
        timeout: getSuggestionsTimeoutMs(),
        maxRetries: 0,
        signal: options.abortSignal,
      },
    );

    const parser = new SuggestionsStreamParser();
    let assembled = "";
    let reasoningFallback = "";

    for await (const chunk of completion) {
      if (options.abortSignal?.aborted) {
        break;
      }

      const delta = chunk.choices[0]?.delta as
        | { content?: string | null; reasoning_content?: string | null }
        | undefined;
      const token = delta?.content ?? "";
      const reasoningToken = delta?.reasoning_content ?? "";

      if (reasoningToken) {
        reasoningFallback += reasoningToken;
      }

      if (!token) {
        continue;
      }

      assembled += token;
      const { completedElements } = parser.append(token);

      for (const { raw, index } of completedElements) {
        const card = coerceStreamedCard(raw, index);
        if (card) {
          onIncrementalCard(card, index);
        }
      }
    }

    const source = assembled.trim() ? assembled : reasoningFallback.trim();
    if (!source) {
      throw new SuggestionGenerationError("Failed to parse suggestions from model output.");
    }

    const rawJson = extractJsonObject(source);
    const parsedContent = JSON.parse(rawJson) as SuggestionsSchemaResponse;
    const normalized = parsedContent.suggestions.map((suggestion, index) =>
      normalizeSuggestion(suggestion, index),
    );
    const validated = validateSuggestions(normalized, verbatim_recent);

    const meta: SuggestionMeta = {
      meeting_type: parsedContent.meta?.meeting_type?.trim() || meeting_type || "unspecified",
      conversation_stage:
        parsedContent.meta?.conversation_stage?.trim() || conversation_stage || "unspecified",
    };

    return { cards: validated, meta };
  };

  try {
    let retryFired = false;
    let result: StreamAttemptResult;

    try {
      result = await runStream(baseMessages, (card, index) => {
        handlers.onCard(card, index);
      });
    } catch (firstError) {
      if (
        firstError instanceof SuggestionGenerationError &&
        firstError.message.includes("type mix")
      ) {
        console.warn("[TwinMind][suggestions][stream] type-mix violation detected, retrying once");
        console.info("[suggestions] type-mix retry fired", {
          firstErrorMessage: firstError.message,
          modelName: getLargeModelName(),
          expandedContext: isLargeModelExpandedContext(),
        });
        handlers.onRetrying("type-mix");
        retryFired = true;

        result = await runStream(
          [
            ...baseMessages,
            {
              role: "user",
              content:
                "Your previous attempt returned suggestions that collapsed to one type. Regenerate with at least 2 distinct types chosen from { question, talking_point, answer, fact_check, clarification }. Pick types that reflect what the transcript actually calls for: use 'answer' or 'fact_check' only when the transcript contains a specific answerable question or verifiable claim; use 'clarification' when language is genuinely ambiguous; default to 'question' + 'talking_point' otherwise. Return the same strict JSON schema.",
            },
          ],
          (card, index) => {
            handlers.onCard(card, index, { replace: true });
          },
        );
      } else {
        throw firstError;
      }
    }

    handlers.onDone({
      batch_id: batchId,
      total_cards: result.cards.length,
      critique_used: retryFired,
      retry_fired: retryFired,
      meta: result.meta,
    });
  } catch (error) {
    if (options.abortSignal?.aborted) {
      console.info("[suggestions] stream cancelled");
      handlers.onError("Stream cancelled by client.", "aborted");
      return;
    }

    if (error instanceof SuggestionGenerationError && error.message.includes("type mix")) {
      handlers.onError(
        "Suggestion type mix validation failed (after 1 retry).",
        "type_mix_retry_failed",
      );
      return;
    }

    if (error instanceof SuggestionGenerationError) {
      handlers.onError(error.message, "validation_failed");
      return;
    }

    if (error instanceof SyntaxError) {
      handlers.onError("Failed to parse suggestions from model output.", "parse_failed");
      return;
    }

    if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        handlers.onError("Invalid API key", "invalid_key");
      } else if (status === 429) {
        handlers.onError("Rate limit hit", "rate_limited");
      } else if (status === 408 || error.name === "APITimeoutError") {
        handlers.onError("Request timeout", "timeout");
      } else {
        handlers.onError(error.message || "Upstream provider error.", "provider_error");
      }
      return;
    }

    if (error instanceof Groq.APIConnectionTimeoutError) {
      handlers.onError("Suggestion generation timed out.", "timeout");
      return;
    }

    if (error instanceof Error) {
      handlers.onError(error.message || "Failed to generate suggestions.", "unknown");
      return;
    }

    handlers.onError("Failed to generate suggestions.", "unknown");
  }
};
