import { buildVerbatimRecent } from "@/lib/verbatim";
import type { ChatMessage, ContextBundle, RollingSummary, SalientMoment, SuggestionMeta, TranscriptChunk } from "@/lib/types";

type BuildContextBundleInput = {
  rollingSummary: RollingSummary | null;
  chunks: TranscriptChunk[];
  salientMemory: SalientMoment[];
  meta?: SuggestionMeta;
  chatHistory: ChatMessage[];
};

const trimTopic = (value: string) => {
  const normalized = value.trim();

  if (normalized.length <= 200) {
    return normalized;
  }

  return `${normalized.slice(0, 197).trimEnd()}...`;
};

export type { ContextBundle } from "@/lib/types";

export function buildContextBundle(input: BuildContextBundleInput): ContextBundle {
  const recentChatTopics = input.chatHistory
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => trimTopic(message.content))
    .filter(Boolean);

  return {
    rollingSummary: input.rollingSummary,
    verbatimRecent: buildVerbatimRecent(input.chunks),
    salientMemory: input.salientMemory,
    meta: input.meta,
    recentChatTopics,
  };
}
