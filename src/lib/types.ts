export type TranscriptChunk = {
  id: string;
  timestamp: Date;
  text: string;
  speaker?: string;
};

export type SuggestionType =
  | "question"
  | "talking_point"
  | "answer"
  | "fact_check"
  | "clarification";

export type SuggestionConviction = "high" | "medium";

export type Suggestion = {
  id: string;
  type: SuggestionType;
  conviction?: SuggestionConviction;
  preview: string;
  full_content: string;
  evidence_quote: string;
  rationale: string;
  why_relevant: string;
  source_url?: string;
  source_title?: string;
  source_scope?: string;
  trigger?: string;
  selection_reason?: string;
};

export type SuggestionCandidate = {
  type: SuggestionType;
  conviction?: SuggestionConviction;
  preview: string;
  full_content: string;
  evidence_quote: string;
  rationale: string;
  source_url?: string;
};

export type SuggestionGroundingDebug = {
  entities_found: number;
  entities: string[];
  searches_used: number;
  searches_remaining: number;
  cache_hits: number;
  facts_count: number;
  skipped_reason?: "disabled" | "no_api_key" | "cap_reached" | "no_entities";
};

export type SuggestionPipelineDebug = {
  candidates: SuggestionCandidate[];
  selections: Suggestion[];
  fell_back_to_raw: boolean;
  critique_skipped_budget: boolean;
  retry_fired: boolean;
  call_a_ms?: number;
  call_b_ms?: number;
  grounding?: SuggestionGroundingDebug;
};

export type SuggestionMeta = {
  meeting_type: string;
  conversation_stage: string;
  grounding?: {
    searches_used: number;
    searches_remaining: number;
    facts_count: number;
    skipped_reason?: string;
  };
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
  meeting_type?: string;
  conversation_stage?: string;
  salient_memory?: SalientMoment[];
  session_id?: string;
  debug?: boolean;
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

export type MeetingWrapUp = {
  gist: string;
  agenda: string[];
  generated_at: string;
};

export type WrapUpRequest = {
  full_transcript: string;
  rolling_summary?: RollingSummary | null;
  salient_memory?: SalientMoment[];
  meeting_type?: string;
};

export type WrapUpResponse = {
  wrap_up: MeetingWrapUp | null;
  error?: string;
};

export type ChatStreamEvent =
  | {
      token: string;
    }
  | {
      error: string;
    };

export type SuggestionStreamDoneSummary = {
  batch_id: string;
  total_cards: number;
  critique_used: boolean;
  retry_fired: boolean;
  meta?: SuggestionMeta;
};

export type SuggestionStreamEvent =
  | {
      type: "grounding";
      entities_found: number;
      entities: string[];
      searches_used: number;
      searches_remaining: number;
      cache_hits: number;
      facts_count: number;
      skipped_reason?: "disabled" | "no_api_key" | "cap_reached" | "no_entities";
    }
  | {
      type: "meta";
      batch_id: string;
      generated_at: string;
      meeting_type: string;
      conversation_stage: string;
    }
  | {
      type: "critique_starting";
      candidate_count: number;
    }
  | {
      type: "card";
      index: number;
      suggestion: Suggestion;
      replace?: boolean;
    }
  | {
      type: "retrying";
      reason: string;
    }
  | {
      type: "debug";
      pipeline: SuggestionPipelineDebug;
    }
  | {
      type: "done";
      batch_id: string;
      total_cards: number;
      critique_used: boolean;
      retry_fired: boolean;
      meta?: SuggestionMeta;
    }
  | {
      type: "error";
      message: string;
      code: string;
    };
