"use client";

import { FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Suggestion, TranscriptChunk } from "@/lib/types";

type ChatPanelProps = {
  error: string | null;
  inputId?: string;
  isLoading: boolean;
  messages: ChatMessage[];
  onJumpToTimestamp: (timestamp: string) => void;
  onOpenSettings?: () => void;
  onRetryMessage: (messageId: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  onSendMessage: (message: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  transcript: TranscriptChunk[];
};

const MAX_MESSAGE_LENGTH = 500;
const CITATION_PATTERN = /\[(\d{2}:\d{2})\]\s*["“”]([^"“”]+)["“”]/g;

const suggestionTypeLabel = (type: Suggestion["type"]) => {
  switch (type) {
    case "question":
      return "Question to Ask";
    case "talking_point":
      return "Talking Point";
    case "fact_check":
      return "Fact-Check";
    case "clarification":
      return "Clarify";
    case "answer":
      return "Answer";
    default:
      return null;
  }
};

const parseAssistantMessage = (content: string) => {
  const generalKnowledgePrefixPattern =
    /^Not in transcript\s*[—-]\s*based on general knowledge:\s*/i;
  const followUpMatch = content.match(/(?:^|\n)Consider asking:\s*([\s\S]*)$/i);
  const followUpBlock = followUpMatch?.[1]?.trim() ?? "";
  const bodyWithPrefix = followUpMatch ? content.slice(0, followUpMatch.index).trim() : content.trim();
  const usesGeneralKnowledge = generalKnowledgePrefixPattern.test(bodyWithPrefix);
  const body = bodyWithPrefix.replace(generalKnowledgePrefixPattern, "").trim();
  const citations = Array.from(body.matchAll(CITATION_PATTERN)).map((match) => ({
    timestamp: match[1],
    quote: match[2],
  }));
  const quotedFollowUps = Array.from(followUpBlock.matchAll(/["“”]([^"“”]+)["“”]/g)).map(
    (match) => match[1].trim(),
  );
  const followUps =
    quotedFollowUps.length > 0
      ? quotedFollowUps
      : followUpBlock
          .split(/\n|;/)
          .map((line) => line.replace(/^[-•]\s*/, "").trim())
          .filter(Boolean);

  return {
    body,
    citations,
    followUps: followUps.slice(0, 2),
    usesGeneralKnowledge,
  };
};

const ChatMessageCard = memo(function ChatMessageCard({
  isLastAssistantMessage,
  message,
  onJumpToTimestamp,
  onRetryMessage,
  onSendMessage,
  transcript,
  userSuggestionLabel,
}: {
  isLastAssistantMessage: boolean;
  message: ChatMessage;
  onJumpToTimestamp: (timestamp: string) => void;
  onRetryMessage: (messageId: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  onSendMessage: (message: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  transcript: TranscriptChunk[];
  userSuggestionLabel?: string | null;
}) {
  const isAssistant = message.role === "assistant";
  const parsedAssistantMessage = isAssistant ? parseAssistantMessage(message.content) : null;
  const showFollowUps =
    isAssistant &&
    isLastAssistantMessage &&
    !message.isStreaming &&
    !message.streamError &&
    (parsedAssistantMessage?.followUps.length ?? 0) > 0;

  if (isAssistant) {
    return (
      <article>
        <div className="chat-row-label">TwinMind</div>
        <div className="bubble-ai">
          {parsedAssistantMessage?.usesGeneralKnowledge ? (
            <p className="mb-2 text-[11px] font-medium text-[var(--amber)]">
              Not in transcript — based on general knowledge:
            </p>
          ) : null}

          <div className="whitespace-pre-wrap">
            {parsedAssistantMessage?.body}
            {message.isStreaming ? <span className="stream-cursor" /> : null}
          </div>

          {parsedAssistantMessage && parsedAssistantMessage.citations.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {parsedAssistantMessage.citations.map((citation) => (
                <button
                  key={`${message.id}-${citation.timestamp}-${citation.quote}`}
                  className="citation-chip"
                  type="button"
                  onClick={() => onJumpToTimestamp(citation.timestamp)}
                >
                  [{citation.timestamp}] &quot;{citation.quote}&quot;
                </button>
              ))}
            </div>
          ) : null}

          {showFollowUps && parsedAssistantMessage ? (
            <div className="mt-3">
              <div className="chat-row-label">Consider asking</div>
              <div className="flex flex-wrap gap-2">
                {parsedAssistantMessage.followUps.map((followUp) => (
                  <button
                    key={`${message.id}-${followUp}`}
                    className="follow-chip"
                    type="button"
                    onClick={() => {
                      void onSendMessage(followUp, transcript);
                    }}
                  >
                    {followUp}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {message.streamError ? (
            <div className="mt-3">
              <p className="text-[11px] leading-[1.55] text-[var(--rose)]">
                {message.errorMessage || "The response stream ended early."}
              </p>
              <button
                className="chat-inline-action mt-1"
                type="button"
                onClick={() => {
                  void onRetryMessage(message.id, transcript);
                }}
              >
                Retry answer
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <div className="flex justify-end">
      <article className="max-w-[88%]">
        <div className="chat-row-label">
          {userSuggestionLabel ? `You · ${userSuggestionLabel}` : "You"}
        </div>
        <div className="bubble-user">{message.content}</div>
      </article>
    </div>
  );
});

export function ChatPanel({
  error,
  inputId = "chat-input",
  isLoading,
  messages,
  onJumpToTimestamp,
  onOpenSettings,
  onRetryMessage,
  onSendMessage,
  transcript,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") {
        return messages[index].id;
      }
    }

    return null;
  }, [messages]);
  const isApiKeyError = error?.toLowerCase().includes("api key") ?? false;
  const userSuggestionLabels = useMemo(() => {
    const labelMap = new Map<string, string>();

    messages.forEach((message, index) => {
      if (message.role !== "user") {
        return;
      }

      const nextAssistant = messages
        .slice(index + 1)
        .find((candidate) => candidate.role === "assistant");
      const suggestionType = nextAssistant?.requestSuggestion?.type;

      if (suggestionType && nextAssistant?.requestMessage === message.content) {
        const label = suggestionTypeLabel(suggestionType);
        if (label) {
          labelMap.set(message.id, label);
        }
      }
    });

    return labelMap;
  }, [messages]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [isLoading, messages]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
  }, [draft]);

  const submitDraft = () => {
    const trimmedDraft = draft.trim();

    if (!trimmedDraft || isLoading) {
      return;
    }

    void onSendMessage(trimmedDraft, transcript);
    setDraft("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitDraft();
  };

  return (
    <section aria-label="Chat panel" className="flex h-full min-h-0 flex-col">
      <div className="col-body col-scroll">
        <div className="chat-hint">
          Clicking a suggestion adds it to this chat and streams a detailed answer. You can also
          type questions directly below.
        </div>

        {error ? (
          <div className="mb-3 rounded-[var(--radius)] border border-[rgba(248,113,113,.22)] bg-[rgba(248,113,113,.08)] px-3 py-2 text-[11px] leading-[1.55] text-[var(--rose)]">
            <p>{error}</p>
            {isApiKeyError && onOpenSettings ? (
              <button className="chat-inline-action mt-1" type="button" onClick={onOpenSettings}>
                Open Settings
              </button>
            ) : null}
          </div>
        ) : null}

        {messages.length === 0 ? (
          <div className="text-[12px] leading-[1.6] text-[var(--text-dim)]">
            No deep-dive thread yet. Click a suggestion card or ask a direct question.
          </div>
        ) : null}

        <div className="space-y-0">
          {messages.map((message) => (
            <ChatMessageCard
              key={message.id}
              isLastAssistantMessage={lastAssistantMessageId === message.id}
              message={message}
              onJumpToTimestamp={onJumpToTimestamp}
              onRetryMessage={onRetryMessage}
              onSendMessage={onSendMessage}
              transcript={transcript}
              userSuggestionLabel={userSuggestionLabels.get(message.id)}
            />
          ))}
          <div ref={scrollAnchorRef} />
        </div>
      </div>

      <form className="chat-footer" onSubmit={handleSubmit}>
        <div className="chat-input-row">
          <label className="sr-only" htmlFor={inputId}>
            Ask anything about the conversation
          </label>
          <textarea
            ref={textareaRef}
            id={inputId}
            aria-label="Ask anything about the conversation"
            data-chat-input="true"
            className="chat-input"
            maxLength={MAX_MESSAGE_LENGTH}
            name={inputId}
            placeholder="Ask anything about the conversation…"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitDraft();
              }
            }}
            disabled={isLoading}
          />
          <button
            aria-label="Send message"
            className="send-btn disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoading || draft.trim().length === 0}
            type="submit"
          >
            <svg aria-hidden="true" className="send-icon" viewBox="0 0 24 24">
              <line x1="22" x2="11" y1="2" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </form>
    </section>
  );
}
