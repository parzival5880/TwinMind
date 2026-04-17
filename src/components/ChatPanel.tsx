"use client";

import { FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import type { ChatMessage, TranscriptChunk } from "@/lib/types";

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
}: {
  isLastAssistantMessage: boolean;
  message: ChatMessage;
  onJumpToTimestamp: (timestamp: string) => void;
  onRetryMessage: (messageId: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  onSendMessage: (message: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  transcript: TranscriptChunk[];
}) {
  const isAssistant = message.role === "assistant";
  const parsedAssistantMessage = isAssistant ? parseAssistantMessage(message.content) : null;
  const showFollowUps =
    isAssistant &&
    isLastAssistantMessage &&
    !message.isStreaming &&
    !message.streamError &&
    (parsedAssistantMessage?.followUps.length ?? 0) > 0;

  return (
    <div className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
      <article
        className={`max-w-[88%] rounded-[1.5rem] p-4 shadow-sm ${
          isAssistant
            ? "bg-slate-950 text-slate-100"
            : "border border-slate-200 bg-slate-50 text-slate-800"
        }`}
      >
        <div className="mb-2 flex items-center justify-between gap-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em]">
            {message.role === "user" ? "You" : "Assistant"}
          </p>
          <p className="text-xs uppercase tracking-[0.16em] opacity-70">
            {format(message.timestamp, "HH:mm:ss")}
          </p>
        </div>

        {isAssistant ? (
          <div className="space-y-3">
            <div className="whitespace-pre-wrap text-sm leading-6">
              {parsedAssistantMessage?.usesGeneralKnowledge ? (
                <p className="mb-3 rounded-[1rem] border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-amber-100">
                  Not in transcript — based on general knowledge:
                </p>
              ) : null}
              {parsedAssistantMessage?.body}
              {message.isStreaming ? (
                <span
                  aria-hidden="true"
                  className="streaming-cursor ml-1 inline-block h-4 w-[2px] bg-teal-300 align-middle"
                />
              ) : null}
            </div>

            {parsedAssistantMessage && parsedAssistantMessage.citations.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {parsedAssistantMessage.citations.map((citation) => (
                  <button
                    key={`${message.id}-${citation.timestamp}-${citation.quote}`}
                    className="rounded-full border border-teal-700/40 bg-teal-500/10 px-3 py-1 text-xs font-medium text-teal-200 transition hover:border-teal-300 hover:bg-teal-500/20"
                    type="button"
                    onClick={() => onJumpToTimestamp(citation.timestamp)}
                  >
                    [{citation.timestamp}] &quot;{citation.quote}&quot;
                  </button>
                ))}
              </div>
            ) : null}

            {showFollowUps && parsedAssistantMessage ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300/80">
                  Consider asking
                </p>
                <div className="flex flex-wrap gap-2">
                  {parsedAssistantMessage.followUps.map((followUp) => (
                    <button
                      key={`${message.id}-${followUp}`}
                      className="rounded-full border border-amber-300/35 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-100 transition hover:border-amber-200 hover:bg-amber-400/20"
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
              <div className="space-y-2 rounded-[1rem] border border-rose-300/30 bg-rose-500/10 p-3">
                <p className="text-xs leading-5 text-rose-100">
                  {message.errorMessage || "The response stream ended early."}
                </p>
                <button
                  className="rounded-full border border-rose-200/60 px-3 py-1 text-xs font-semibold text-rose-50 transition hover:border-rose-100 hover:bg-rose-400/15"
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
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
        )}
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
  const lastAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") {
        return messages[index].id;
      }
    }

    return null;
  }, [messages]);
  const isApiKeyError = error?.toLowerCase().includes("api key") ?? false;
  const statusLabel = error ? "Error" : isLoading ? "Loading" : messages.length === 0 ? "Idle" : "Success";
  const statusClassName = error
    ? "bg-rose-100 text-rose-700"
    : isLoading
      ? "bg-sky-100 text-sky-700"
      : messages.length === 0
        ? "bg-slate-200 text-slate-700"
        : "bg-emerald-100 text-emerald-700";

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [isLoading, messages]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedDraft = draft.trim();

    if (!trimmedDraft || isLoading) {
      return;
    }

    void onSendMessage(trimmedDraft, transcript);
    setDraft("");
  };

  return (
    <section
      aria-label="Chat panel"
      className="soft-panel flex h-full min-h-0 flex-col rounded-[2rem] p-6"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Chat</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            Detailed answers
          </h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-slate-600">
            Ask a question directly or click a suggestion card to stream a grounded answer with
            transcript citations.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold shadow-sm ${statusClassName}`}>
          {statusLabel}
        </span>
      </div>

      {error ? (
        <div className="mb-4 rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <p>{error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {isApiKeyError && onOpenSettings ? (
              <button
                className="rounded-full border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:border-rose-500 hover:text-rose-800"
                type="button"
                onClick={onOpenSettings}
              >
                Open Settings
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="panel-scroll flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <article className="rounded-[1.25rem] border border-dashed border-slate-300 bg-slate-50/80 p-4">
            <p className="text-sm leading-6 text-slate-500">
              Click any suggestion to expand it here, or ask your own question.
            </p>
          </article>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className="animate-message-in">
            <ChatMessageCard
              isLastAssistantMessage={lastAssistantMessageId === message.id}
              message={message}
              onJumpToTimestamp={onJumpToTimestamp}
              onRetryMessage={onRetryMessage}
              onSendMessage={onSendMessage}
              transcript={transcript}
            />
          </div>
        ))}
        <div ref={scrollAnchorRef} />
      </div>

      <form className="mt-5 flex flex-col gap-3" onSubmit={handleSubmit}>
        <label className="text-sm font-semibold text-slate-700" htmlFor={inputId}>
          Ask a follow-up
        </label>
        <textarea
          id={inputId}
          aria-label="Ask a follow-up question"
          data-chat-input="true"
          className="min-h-28 rounded-[1.5rem] border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-teal-600 disabled:cursor-not-allowed disabled:bg-slate-50"
          maxLength={MAX_MESSAGE_LENGTH}
          name={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, MAX_MESSAGE_LENGTH))}
          disabled={isLoading}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
            {draft.length}/{MAX_MESSAGE_LENGTH}
          </p>
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
            {transcript.length} transcript chunks available
          </p>
        </div>
        <button
          className="inline-flex items-center justify-center gap-2 rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isLoading || draft.trim().length === 0}
          type="submit"
        >
          {isLoading ? <span aria-hidden="true" className="subtle-spinner" /> : null}
          Send Message
        </button>
      </form>
    </section>
  );
}
