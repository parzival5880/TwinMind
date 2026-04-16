import type { SettingsConfig, Suggestion } from "@/lib/types";

// These prompt templates are edited in Settings and receive runtime context injection
// before each Groq call. Keep the placeholders intact so transcript and chat state
// can be merged into the final prompt safely.
export const DEFAULT_PROMPTS = {
  live_suggestions: `You are a helpful meeting assistant. Your role is to generate exactly 3 suggestions that would add immediate value to the ongoing conversation.

Recent conversation:
{recent_transcript}

Generate exactly 3 suggestions. Vary the types to cover different values:

One suggestion that asks a clarifying or deepening question
One suggestion that provides useful context or perspective
One suggestion that could be an answer, fact-check, or additional relevant info
Keep suggestions concise (2-3 sentences each for preview, with expanded detail available).
Make each suggestion independently useful even if not clicked.

Ensure suggestions are:

Directly relevant to what's being discussed (no generic advice)
Different from each other in type and topic
Not repetitive of recent suggestions (they should feel fresh)
Return as JSON only, no markdown:
{
  "suggestions": [
    {
      "type": "string (question/talking_point/answer/fact_check/clarification)",
      "preview": "string (2-3 sentence standalone summary)",
      "full_content": "string (expanded explanation, 5-10 sentences)"
    }
  ]
}`,
  detailed_answer: `You are a meeting assistant providing detailed answers. Answer the user's question using the full context of their meeting.

Meeting transcript:
{full_transcript}

User's question or topic of interest:
{user_query}

Provide a thorough, well-structured answer that:

References specific parts of the transcript when relevant
Explains context clearly for someone who was in the meeting
Suggests actionable next steps if appropriate
Stays factual and grounded in what was discussed
Keep the tone professional but conversational.`,
  chat: `You are a meeting assistant answering questions during an ongoing meeting. Refer to the transcript to ground your answers.

Transcript so far:
{full_transcript}

Previous chat history (for context):
{chat_history}

User's question:
{user_message}

Answer clearly and conversationally, referencing the transcript when helpful.
Be concise unless more detail would be valuable.`,
} as const;

export const PROMPT_MAX_LENGTH = 2000;

export const DEFAULT_CONTEXT_WINDOWS = {
  suggestions: 2000,
  answers: 4000,
} as const;

export const DEFAULT_SETTINGS: SettingsConfig = {
  groq_api_key: process.env.NEXT_PUBLIC_GROQ_API_KEY ?? "",
  live_suggestion_prompt: DEFAULT_PROMPTS.live_suggestions,
  detailed_answer_prompt: DEFAULT_PROMPTS.detailed_answer,
  chat_prompt: DEFAULT_PROMPTS.chat,
  context_window_suggestions: DEFAULT_CONTEXT_WINDOWS.suggestions,
  context_window_answers: DEFAULT_CONTEXT_WINDOWS.answers,
};

type BuildSuggestionsPromptParams = {
  contextWindow: number;
  fullTranscript: string;
  previousSuggestions: Suggestion[];
  promptTemplate?: string;
  transcriptChunk: string;
};

const FALLBACK_TRANSCRIPT = "No meeting transcript is available yet.";
const FALLBACK_PREVIOUS_SUGGESTIONS = "No previous suggestions.";

export const estimateTokenCount = (value: string) => Math.ceil(value.length / 4);

// The transcript is trimmed from the end so the newest discussion remains in view
// while keeping the injected context close to the requested token budget.
export const trimTextToContextWindow = (value: string, contextWindow: number) => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return FALLBACK_TRANSCRIPT;
  }

  const lines = normalizedValue.split("\n").filter((line) => line.trim().length > 0);
  const selectedLines: string[] = [];
  let estimatedTokens = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineTokens = estimateTokenCount(line) + 1;

    if (selectedLines.length > 0 && estimatedTokens + lineTokens > contextWindow) {
      break;
    }

    selectedLines.unshift(line);
    estimatedTokens += lineTokens;
  }

  return selectedLines.join("\n");
};

const dedupePreviousSuggestions = (suggestions: Suggestion[]) => {
  const seenSuggestions = new Set<string>();

  return suggestions.filter((suggestion) => {
    const fingerprint = `${suggestion.type}::${suggestion.preview.trim().toLowerCase()}::${suggestion.full_content
      .trim()
      .toLowerCase()}`;

    if (seenSuggestions.has(fingerprint)) {
      return false;
    }

    seenSuggestions.add(fingerprint);

    return true;
  });
};

// Live suggestions receive three context blocks:
// 1. the most recent transcript window,
// 2. the latest chunk to bias toward what just changed,
// 3. previous suggestions so the model avoids repetition across batches.
export const buildSuggestionsPrompt = ({
  contextWindow,
  fullTranscript,
  previousSuggestions,
  promptTemplate,
  transcriptChunk,
}: BuildSuggestionsPromptParams) => {
  const recentTranscript = trimTextToContextWindow(fullTranscript, contextWindow);
  const dedupedSuggestions = dedupePreviousSuggestions(previousSuggestions);
  const previousSuggestionsBlock =
    dedupedSuggestions.length > 0
      ? dedupedSuggestions
          .map(
            (suggestion, index) =>
              `${index + 1}. [${suggestion.type}] ${suggestion.preview}\n${suggestion.full_content}`,
          )
          .join("\n\n")
      : FALLBACK_PREVIOUS_SUGGESTIONS;

  const baseTemplate = promptTemplate?.trim() || DEFAULT_PROMPTS.live_suggestions;
  const templatedPrompt = baseTemplate.replace("{recent_transcript}", recentTranscript);

  const prompt = `${templatedPrompt}

RECENT CONVERSATION:
${recentTranscript}

LATEST TRANSCRIPT CHUNK:
${transcriptChunk.trim() || "No new transcript chunk was provided."}

PREVIOUS SUGGESTIONS TO AVOID REPEATING:
${previousSuggestionsBlock}

Generate exactly 3 suggestions:
- Keep all three suggestions unique in topic and wording.
- Include at least one question.
- Mix the suggestion types. Do not return three of the same type.
- Keep each preview under 50 words.
- Keep each full_content between 100 and 300 words.
- Ground every suggestion in the transcript and current conversation momentum.`;

  return {
    prompt,
    recentTranscript,
  };
};
