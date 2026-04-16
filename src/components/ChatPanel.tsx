"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import type { ChatMessage, TranscriptChunk } from "@/lib/types";

type ChatPanelProps = {
  error: string | null;
  inputId?: string;
  isLoading: boolean;
  messages: ChatMessage[];
  onSendMessage: (message: string, transcript: TranscriptChunk[]) => Promise<void> | void;
  transcript: TranscriptChunk[];
};

const MAX_MESSAGE_LENGTH = 500;

export function ChatPanel({
  error,
  inputId = "chat-input",
  isLoading,
  messages,
  onSendMessage,
  transcript,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [isLoading, messages.length]);

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
            Ask a question directly or click a suggestion card to turn it into a detailed answer.
          </p>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="panel-scroll flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <article className="rounded-[1.25rem] border border-dashed border-slate-300 bg-slate-50/80 p-4">
            <p className="text-sm leading-6 text-slate-500">
              The session chat starts empty and clears on page reload. Send a question or tap a
              suggestion to begin.
            </p>
          </article>
        ) : null}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <article
              className={`max-w-[88%] rounded-[1.5rem] p-4 shadow-sm ${
                message.role === "assistant"
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
              <p className="text-sm leading-6">{message.content}</p>
            </article>
          </div>
        ))}
        {isLoading ? (
          <div className="flex justify-start">
            <article className="max-w-[88%] rounded-[1.5rem] bg-slate-950 p-4 text-slate-100 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-70">
                Assistant
              </p>
              <div className="mt-2 flex items-center gap-3 text-sm leading-6">
                <span aria-hidden="true" className="subtle-spinner" />
                <p>Assistant typing...</p>
              </div>
            </article>
          </div>
        ) : null}
        <div ref={scrollAnchorRef} />
      </div>

      <form className="mt-5 flex flex-col gap-3" onSubmit={handleSubmit}>
        <label className="text-sm font-semibold text-slate-700" htmlFor={inputId}>
          Ask a follow-up
        </label>
        <textarea
          id={inputId}
          aria-label="Ask a follow-up question"
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
