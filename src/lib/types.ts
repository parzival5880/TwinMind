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
  evidence_quote: string;
  why_relevant: string;
  trigger?: string;
};

export type SuggestionMeta = {
  meeting_type: string;
  conversation_stage: string;
  grounding_audit?: Array<{ id: string; grounded: boolean; score: number }>;
};

export type ContextBundle = {
  rollingSummary: RollingSummary | null;
  verbatimRecent: string;
  salientMemory: SalientMoment[];
  meta?: SuggestionMeta;
  recentChatTopics: string[];
};

export type SuggestionBatch = {
  id: string;
  suggestions: Suggestion[];
  meta?: SuggestionMeta;
  timestamp: Date;
};

export type SalientCategory =
  | "claim"
  | "question"
  | "decision"
  | "commitment"
  | "objection"
  | "key_entity";

export type SalientStatus = "open" | "addressed";

export type SalientMoment = {
  id: string;
  timestamp: number;
  category: SalientCategory;
  summary: string;
  verbatim: string;
  importance: 1 | 2 | 3 | 4 | 5;
  status: SalientStatus;
  addressed_at?: number;
};

export type SalienceExtractionRequest = {
  transcript_slice: string;
  open_moments: Array<Pick<SalientMoment, "id" | "category" | "summary" | "verbatim">>;
};

export type SalienceExtractionRaw = {
  new_moments: Array<{
    category: SalientCategory;
    summary: string;
    verbatim: string;
    importance: number;
  }>;
  resolved_ids: string[];
};

export type SalienceExtractionResponse = {
  new_moments: Array<Omit<SalientMoment, "id" | "timestamp" | "status" | "addressed_at">>;
  resolved_ids: string[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  errorMessage?: string;
  isStreaming?: boolean;
  requestMessage?: string;
  requestPromptTemplate?: string;
  requestSuggestion?: Suggestion;
  requestMeta?: SuggestionMeta;
  streamError?: boolean;
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
  startMs?: number;
  endMs?: number;
};

export type SuggestionsRequest = {
  transcript_chunk: string;
  full_transcript: string;
  verbatim_recent?: string;
  rolling_summary?: string | RollingSummary | null;
  recent_chat_topics?: string;
  avoid_phrases?: string[];
  context_window?: number;
  prompt_template?: string;
  meeting_type?: string;
  conversation_stage?: string;
  salient_memory?: SalientMoment[];
};

export type SuggestionsResponse = {
  success: boolean;
  suggestions: Suggestion[];
  meta?: SuggestionMeta;
  timestamp: string;
  error?: string;
};

export type RollingSummary = {
  topic: string;
  stance: string;
  phase: "exploring" | "converging" | "deciding" | "wrapping" | "unclear";
  tone: "analytical" | "tense" | "aligned" | "stalled" | "exploratory" | "neutral";
  participants_heard: string[];
};

export type RollingSummaryRequest = {
  full_transcript: string;
};

export type RollingSummaryResponse = {
  summary: RollingSummary | null;
};

export type ChatRequest = {
  message: string;
  history: ChatMessage[];
  suggestion?: Suggestion;
  context: ContextBundle;
};

export type ChatResponse = {
  success: boolean;
  message: string;
  timestamp: string;
  error?: string;
};

export type ChatStreamEvent =
  | {
      token: string;
    }
  | {
      error: string;
    };
