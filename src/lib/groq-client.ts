import Groq from "groq-sdk";
import {
  DEFAULT_PROMPTS,
  buildSuggestionsPrompt,
  trimTextToContextWindow,
} from "@/lib/prompts";
import type {
  ChatRequest,
  SerializedChatMessage,
  Suggestion,
  SuggestionsRequest,
} from "@/lib/types";

const GROQ_KEY_PREFIX = "gsk_";
const MIN_GROQ_KEY_LENGTH = 24;
const GROQ_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const GROQ_SUGGESTIONS_TIMEOUT_MS = 30_000;
const GROQ_CHAT_TIMEOUT_MS = 30_000;
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
  const extension = mimeType.split("/")[1] ?? "webm";

  return `recording.${extension}`;
};

export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  if (!audioBlob || audioBlob.size === 0) {
    throw new TranscriptionError("Audio data is required for transcription.");
  }

  const client = getGroqClient();

  try {
    const transcription = await client.audio.transcriptions.create(
      {
        file: await Groq.toFile(audioBlob, buildAudioFilename(audioBlob), {
          type: getAudioMimeType(audioBlob),
        }),
        model: WHISPER_MODEL,
        response_format: "json",
      },
      {
        timeout: GROQ_TRANSCRIPTION_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    return transcription.text.trim();
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
      throw new TimeoutError("Groq transcription timed out after 30 seconds.");
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

const normalizeSuggestion = (suggestion: Omit<Suggestion, "id">, index: number): Suggestion => ({
  id: `generated-${index + 1}`,
  type: suggestion.type,
  preview: suggestion.preview.trim(),
  full_content: suggestion.full_content.trim(),
});

const validateSuggestions = (suggestions: Suggestion[]) => {
  if (suggestions.length !== 3) {
    throw new SuggestionGenerationError("Expected exactly 3 suggestions from the model.");
  }

  const uniqueTypes = new Set<Suggestion["type"]>();
  const uniqueFingerprints = new Set<string>();

  suggestions.forEach((suggestion) => {
    if (!SUGGESTION_TYPES.includes(suggestion.type)) {
      throw new SuggestionGenerationError("Suggestion type validation failed.");
    }

    const previewWordCount = countWords(suggestion.preview);
    const fullContentWordCount = countWords(suggestion.full_content);

    if (previewWordCount === 0 || previewWordCount >= 50) {
      throw new SuggestionGenerationError("Suggestion preview length validation failed.");
    }

    if (fullContentWordCount < 100 || fullContentWordCount > 300) {
      throw new SuggestionGenerationError("Suggestion full content length validation failed.");
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

  if (!suggestions.some((suggestion) => suggestion.type === "question")) {
    throw new SuggestionGenerationError("At least one question suggestion is required.");
  }
};

type SuggestionsSchemaResponse = {
  suggestions: Array<{
    type: Suggestion["type"];
    preview: string;
    full_content: string;
  }>;
};

const suggestionsResponseSchema = {
  type: "object",
  properties: {
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
          preview: {
            type: "string",
          },
          full_content: {
            type: "string",
          },
        },
        required: ["type", "preview", "full_content"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
} as const;

export const generateSuggestions = async ({
  context_window,
  full_transcript,
  previous_suggestions = [],
  prompt_template,
  transcript_chunk,
}: SuggestionsRequest): Promise<Suggestion[]> => {
  const client = getGroqClient();
  const contextWindow = Math.max(256, context_window ?? 1800);
  const { prompt, recentTranscript } = buildSuggestionsPrompt({
    contextWindow,
    fullTranscript: full_transcript,
    previousSuggestions: previous_suggestions,
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
              "You are TwinMind, a real-time meeting copilot. Generate fresh, transcript-grounded meeting suggestions that are immediately useful and do not repeat prior ideas.",
          },
          {
            role: "user",
            content: `${prompt}

Context window estimate: approximately ${contextWindow} tokens.

Use only this recent transcript window:
${recentTranscript}`,
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
        temperature: 0.3,
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

    validateSuggestions(suggestions);

    return suggestions;
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
      throw new TimeoutError("Suggestion generation timed out after 30 seconds.");
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

export const generateDetailedAnswer = async ({
  chat_history,
  context_window,
  full_transcript,
  prompt_template,
  user_message,
}: ChatRequest): Promise<string> => {
  const client = getGroqClient();
  const contextWindow = Math.max(512, context_window ?? 4000);
  const transcriptWindow = trimTextToContextWindow(full_transcript, contextWindow);
  const chatHistoryContext = buildChatHistoryContext(chat_history);
  const promptTemplate = prompt_template?.trim() || DEFAULT_PROMPTS.chat;
  const prompt = promptTemplate
    .replace("{full_transcript}", transcriptWindow)
    .replace("{chat_history}", chatHistoryContext)
    .replace("{user_message}", user_message.trim())
    .replace("{user_query}", user_message.trim());

  try {
    const completion = await client.chat.completions.create(
      {
        model: GPT_OSS_120B_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are TwinMind, a real-time meeting copilot. Answer clearly, stay grounded in the transcript, maintain continuity with prior chat messages, and be helpful without fabricating details.",
          },
          {
            role: "user",
            content: `${prompt}

FULL TRANSCRIPT WINDOW:
${transcriptWindow}

RECENT CHAT HISTORY:
${chatHistoryContext}

USER MESSAGE:
${user_message.trim()}`,
          },
        ],
        response_format: {
          type: "text",
        },
        temperature: 0.4,
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
      throw new TimeoutError("Detailed answer generation timed out after 30 seconds.");
    }

    if (error instanceof Error) {
      throw new ChatGenerationError(error.message || "Failed to generate a detailed answer.");
    }

    throw new ChatGenerationError("Failed to generate a detailed answer.");
  }
};
