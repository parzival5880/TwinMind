export type TranscriptChunk = {
  id: string;
  timestamp: Date;
  text: string;
  speaker?: string;
};

export type Suggestion = {
  id: string;
  type: "question" | "talking_point" | "answer" | "fact_check" | "clarification";
  preview: string;
  full_content: string;
};

export type SuggestionBatch = {
  id: string;
  suggestions: Suggestion[];
  timestamp: Date;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
};

export type SerializedChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

export type SessionState = {
  transcript: TranscriptChunk[];
  suggestions: SuggestionBatch[];
  chat: ChatMessage[];
  isRecording: boolean;
};

export type SettingsConfig = {
  groq_api_key: string;
  live_suggestion_prompt: string;
  detailed_answer_prompt: string;
  chat_prompt: string;
  context_window_suggestions: number;
  context_window_answers: number;
};

export type SettingsFieldErrors = Partial<Record<keyof SettingsConfig, string>>;

export type TranscribeResponse = {
  success: boolean;
  text: string;
  timestamp: string;
  error?: string;
};

export type SuggestionsRequest = {
  transcript_chunk: string;
  full_transcript: string;
  previous_suggestions?: Suggestion[];
  context_window?: number;
  prompt_template?: string;
};

export type SuggestionsResponse = {
  success: boolean;
  suggestions: Suggestion[];
  timestamp: string;
  error?: string;
};

export type ChatRequest = {
  user_message: string;
  full_transcript: string;
  chat_history: SerializedChatMessage[];
  context_window?: number;
  prompt_template?: string;
};

export type ChatResponse = {
  success: boolean;
  message: string;
  timestamp: string;
  error?: string;
};
