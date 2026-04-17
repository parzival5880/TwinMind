import Groq from "groq-sdk";
import {
  DEFAULT_PROMPTS,
  buildSuggestionsPrompt,
} from "@/lib/prompts";
import type {
  ChatRequest,
  SerializedChatMessage,
  Suggestion,
  SuggestionMeta,
  SuggestionsRequest,
} from "@/lib/types";

const GROQ_KEY_PREFIX = "gsk_";
const MIN_GROQ_KEY_LENGTH = 24;
const GROQ_TRANSCRIPTION_TIMEOUT_MS = 15_000;
const GROQ_SUGGESTIONS_TIMEOUT_MS = 8_000;
const GROQ_CHAT_TIMEOUT_MS = 25_000;
const GROQ_KEY_VALIDATION_TIMEOUT_MS = 10_000;
const GPT_OSS_120B_MODEL = "openai/gpt-oss-120b";
const WHISPER_MODEL = "whisper-large-v3";
const SUGGESTION_TYPES = [
  "question",
  "talking_point",
  "answer",
  "fact_check",
  "clarification",
] as const;

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
    throw new APIKeyError(
      "A Groq API key is required. Add one in settings before saving.",
    );
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
    throw new APIKeyError(
      "The Groq client has not been initialized yet. Save a valid API key in settings first.",
    );
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
      throw new APIKeyError("The Groq API key was rejected. Check the saved key and try again.");
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
      throw new APIKeyError("The Groq API key was rejected. Check the saved key and try again.");
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

const normalizeSuggestion = (
  suggestion: Omit<Suggestion, "id">,
  index: number,
): Suggestion => ({
  id: `generated-${index + 1}`,
  type: suggestion.type,
  preview: suggestion.preview.trim(),
  full_content: suggestion.full_content.trim(),
  evidence_quote: suggestion.evidence_quote.trim(),
  trigger: suggestion.trigger?.trim() || undefined,
});

const validateSuggestions = (suggestions: Suggestion[], verbatimRecent?: string) => {
  if (suggestions.length !== 3) {
    throw new SuggestionGenerationError("Expected exactly 3 suggestions from the model.");
  }

  const uniqueTypes = new Set<Suggestion["type"]>();
  const uniqueFingerprints = new Set<string>();
  const normalizedVerbatim = verbatimRecent?.trim().toLowerCase() || "";

  suggestions.forEach((suggestion) => {
    if (!SUGGESTION_TYPES.includes(suggestion.type)) {
      throw new SuggestionGenerationError("Suggestion type validation failed.");
    }

    const previewWordCount = countWords(suggestion.preview);
    const fullContentWordCount = countWords(suggestion.full_content);

    // Preview target is ≤25 words but we allow up to 40 before rejecting to
    // avoid spurious retries on borderline responses.
    if (previewWordCount === 0 || previewWordCount > 40) {
      throw new SuggestionGenerationError("Suggestion preview length validation failed.");
    }

    // Full content target is 70-140 words.
    if (fullContentWordCount < 70 || fullContentWordCount > 140) {
      throw new SuggestionGenerationError("Suggestion full_content must be 70-140 words.");
    }

    // evidence_quote: non-empty, ≤15 words, must appear in verbatim_recent.
    const quoteText = suggestion.evidence_quote.trim();

    if (!quoteText) {
      throw new SuggestionGenerationError("Suggestion evidence_quote must be non-empty.");
    }

    if (countWords(quoteText) > 15) {
      throw new SuggestionGenerationError("Suggestion evidence_quote must be ≤15 words.");
    }

    if (normalizedVerbatim && !normalizedVerbatim.includes(quoteText.toLowerCase())) {
      throw new SuggestionGenerationError("Suggestion evidence_quote not found in verbatim_recent.");
    }

    const fingerprint = `${suggestion.type}::${suggestion.preview.toLowerCase()}::${suggestion.full_content.toLowerCase()}`;

    if (uniqueFingerprints.has(fingerprint)) {
      throw new SuggestionGenerationError("Duplicate suggestions were generated.");
    }

    uniqueTypes.add(suggestion.type);
    uniqueFingerprints.add(fingerprint);
  });

  if (uniqueTypes.size < 2) {
    throw new SuggestionGenerationError("Suggestion type mix validation failed.");
  }
};

type SuggestionsSchemaResponse = {
  meta: SuggestionMeta;
  suggestions: Array<{
    type: Suggestion["type"];
    preview: string;
    full_content: string;
    evidence_quote: string;
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
          preview: { type: "string" },
          full_content: { type: "string" },
          evidence_quote: { type: "string", minLength: 1, maxLength: 120 },
          trigger: { type: "string" },
        },
        required: ["type", "preview", "full_content", "evidence_quote", "trigger"],
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

export const generateSuggestions = async ({
  avoid_phrases,
  context_window,
  full_transcript,
  prompt_template,
  recent_chat_topics,
  rolling_summary,
  transcript_chunk,
  verbatim_recent,
}: SuggestionsRequest): Promise<GenerateSuggestionsResult> => {
  const client = getGroqClient();
  const contextWindow = Math.max(256, context_window ?? 1800);
  const { prompt } = buildSuggestionsPrompt({
    contextWindow,
    fullTranscript: full_transcript,
    verbatimRecent: verbatim_recent,
    rollingSummary: rolling_summary,
    recentChatTopics: recent_chat_topics,
    avoidPhrases: avoid_phrases,
    promptTemplate: prompt_template,
    transcriptChunk: transcript_chunk,
  });

  try {
    const completion = await client.chat.completions.create(
      {
        model: GPT_OSS_120B_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are TwinMind, a real-time meeting copilot. Generate fresh, transcript-grounded meeting suggestions that are immediately useful and do not repeat prior ideas. Never fabricate facts, vendor details, pricing, or answers to unresolved questions.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
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
        max_tokens: 900,
        stop: null,
      },
      {
        timeout: GROQ_SUGGESTIONS_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      throw new SuggestionGenerationError("Failed to parse suggestions from model output.");
    }

    const parsedContent = JSON.parse(rawContent) as SuggestionsSchemaResponse;
    const suggestions = parsedContent.suggestions.map((suggestion, index) =>
      normalizeSuggestion(suggestion, index),
    );

    validateSuggestions(suggestions, verbatim_recent);

    const meta: SuggestionMeta = {
      meeting_type: parsedContent.meta?.meeting_type?.trim() || "unspecified",
      conversation_stage: parsedContent.meta?.conversation_stage?.trim() || "unspecified",
    };

    return { suggestions, meta };
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

    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the saved key and try again.");
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

const buildChatHistoryContext = (chatHistory: SerializedChatMessage[]) => {
  const recentMessages = chatHistory.slice(-8);

  if (recentMessages.length === 0) {
    return "No prior chat history.";
  }

  return recentMessages
    .map((message) => `[${message.timestamp}] ${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
};

type TranscriptLine = {
  minuteLabel: string;
  text: string;
};

const toMinuteLabel = (rawTimestamp: string) => {
  const normalized = rawTimestamp.trim();

  if (/^\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }

  if (/^\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized.slice(0, 5);
  }

  const parsedDate = new Date(normalized);

  if (Number.isNaN(parsedDate.getTime())) {
    return "00:00";
  }

  return parsedDate.toISOString().slice(11, 16);
};

const parseTranscriptLines = (fullTranscript: string): TranscriptLine[] =>
  fullTranscript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\[([^\]]+)\]\s*(.+)$/);

      if (!match) {
        return {
          minuteLabel: "00:00",
          text: line,
        };
      }

      return {
        minuteLabel: toMinuteLabel(match[1]),
        text: match[2].trim(),
      };
    });

const formatTranscriptLine = (line: TranscriptLine) => `[${line.minuteLabel}] ${line.text}`;

const buildOlderTranscriptSummary = (lines: TranscriptLine[], tokenBudget: number) => {
  if (lines.length === 0) {
    return "(no earlier transcript summary)";
  }

  const summaryLines: string[] = [];
  let estimatedTokens = 0;

  for (const line of lines) {
    const compactText =
      line.text.length > 140 ? `${line.text.slice(0, 137).trimEnd()}...` : line.text;
    const summaryLine = `- [${line.minuteLabel}] ${compactText}`;
    const lineTokens = Math.ceil(summaryLine.length / 4);

    if (summaryLines.length > 0 && estimatedTokens + lineTokens > tokenBudget) {
      break;
    }

    summaryLines.push(summaryLine);
    estimatedTokens += lineTokens;
  }

  return summaryLines.join("\n");
};

const buildChatTranscriptContext = (fullTranscript: string, contextWindow: number) => {
  const transcriptLines = parseTranscriptLines(fullTranscript);

  if (transcriptLines.length === 0) {
    return "No meeting transcript is available yet.";
  }

  const normalizedTranscript = transcriptLines.map(formatTranscriptLine).join("\n");

  if (Math.ceil(normalizedTranscript.length / 4) <= contextWindow) {
    return normalizedTranscript;
  }

  const recentBudget = Math.max(256, Math.floor(contextWindow * 0.6));
  const summaryBudget = Math.max(128, contextWindow - recentBudget);
  const recentLines: TranscriptLine[] = [];
  let recentTokens = 0;

  for (let index = transcriptLines.length - 1; index >= 0; index -= 1) {
    const line = transcriptLines[index];
    const lineTokens = Math.ceil(formatTranscriptLine(line).length / 4) + 1;

    if (recentLines.length > 0 && recentTokens + lineTokens > recentBudget) {
      break;
    }

    recentLines.unshift(line);
    recentTokens += lineTokens;
  }

  const olderLines = transcriptLines.slice(0, Math.max(0, transcriptLines.length - recentLines.length));
  const rollingSummary = buildOlderTranscriptSummary(olderLines, summaryBudget);
  const verbatimRecent = recentLines.map(formatTranscriptLine).join("\n");

  return `ROLLING SUMMARY OF EARLIER TRANSCRIPT:
${rollingSummary}

RECENT VERBATIM TRANSCRIPT:
${verbatimRecent}`;
};

const buildDetailedAnswerPrompt = ({
  chat_history,
  context_window,
  full_transcript,
  prompt_template,
  user_message,
}: ChatRequest) => {
  const contextWindow = Math.max(512, context_window ?? 4000);
  const transcriptWindow = buildChatTranscriptContext(full_transcript, contextWindow);
  const chatHistoryContext = buildChatHistoryContext(chat_history.slice(-8));
  const promptTemplate = prompt_template?.trim() || DEFAULT_PROMPTS.chat;
  const trimmedUserMessage = user_message.trim();
  const prompt = promptTemplate
    .replace("{full_transcript}", transcriptWindow)
    .replace("{chat_history}", chatHistoryContext)
    .replace("{user_message}", trimmedUserMessage)
    .replace("{user_query}", trimmedUserMessage);

  return {
    chatHistoryContext,
    prompt,
    transcriptWindow,
    trimmedUserMessage,
  };
};

const buildDetailedAnswerMessages = (request: ChatRequest) => {
  const { chatHistoryContext, prompt, transcriptWindow, trimmedUserMessage } =
    buildDetailedAnswerPrompt(request);

  return {
    messages: [
      {
        role: "system" as const,
        content:
          "You are TwinMind, a real-time meeting copilot. Answer clearly, stay grounded in the transcript, maintain continuity with prior chat messages, and be helpful without fabricating details. If the transcript raises a question or unknown, keep it unresolved unless the transcript explicitly answers it. Cite transcript evidence as [HH:MM] \"quoted phrase\" when relevant.",
      },
      {
        role: "user" as const,
        content: `${prompt}

FULL TRANSCRIPT WINDOW:
${transcriptWindow}

RECENT CHAT HISTORY:
${chatHistoryContext}

USER MESSAGE:
${trimmedUserMessage}`,
      },
    ],
  };
};

export const streamDetailedAnswer = async (request: ChatRequest) => {
  const client = getGroqClient();
  const { messages } = buildDetailedAnswerMessages(request);

  try {
    return await client.chat.completions.create(
      {
        model: GPT_OSS_120B_MODEL,
        messages,
        response_format: {
          type: "text",
        },
        temperature: 0.5,
        max_tokens: 800,
        stream: true,
      },
      {
        timeout: GROQ_CHAT_TIMEOUT_MS,
        maxRetries: 0,
      },
    );
  } catch (error) {
    if (error instanceof APIKeyError || error instanceof TimeoutError || error instanceof ChatGenerationError) {
      throw error;
    }

    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the saved key and try again.");
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
  chat_history,
  context_window,
  full_transcript,
  prompt_template,
  user_message,
}: ChatRequest): Promise<string> => {
  const client = getGroqClient();
  const { messages } = buildDetailedAnswerMessages({
    chat_history,
    context_window,
    full_transcript,
    prompt_template,
    user_message,
  });

  try {
    const completion = await client.chat.completions.create(
      {
        model: GPT_OSS_120B_MODEL,
        messages,
        response_format: {
          type: "text",
        },
        temperature: 0.5,
        max_tokens: 800,
      },
      {
        timeout: GROQ_CHAT_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    const content = completion.choices[0]?.message?.content?.trim();

    if (!content) {
      throw new ChatGenerationError("Failed to generate a detailed answer.");
    }

    return content;
  } catch (error) {
    if (error instanceof APIKeyError || error instanceof TimeoutError || error instanceof ChatGenerationError) {
      throw error;
    }

    if (error instanceof Groq.AuthenticationError || error instanceof Groq.PermissionDeniedError) {
      throw new APIKeyError("The Groq API key was rejected. Check the saved key and try again.");
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
