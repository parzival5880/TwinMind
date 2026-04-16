"use client";

import { useState } from "react";
import { format } from "date-fns";
import type { Suggestion, SuggestionBatch } from "@/lib/types";

type SuggestionsPanelProps = {
  error: string | null;
  isLoading: boolean;
  onRefresh: () => void;
  onSuggestionSelected?: (suggestion: Suggestion) => void;
  suggestionBatches: SuggestionBatch[];
};

const toneByType: Record<SuggestionBatch["suggestions"][number]["type"], string> = {
  question: "bg-cyan-100 text-cyan-700",
  talking_point: "bg-amber-100 text-amber-700",
  answer: "bg-emerald-100 text-emerald-700",
  fact_check: "bg-rose-100 text-rose-700",
  clarification: "bg-slate-200 text-slate-700",
};

const iconByType: Record<Suggestion["type"], string> = {
  question: "?",
  talking_point: "💡",
  answer: "✓",
  fact_check: "🔍",
  clarification: "ℹ",
};

export function SuggestionsPanel({
  error,
  isLoading,
  onRefresh,
  onSuggestionSelected,
  suggestionBatches,
}: SuggestionsPanelProps) {
  const [expandedSuggestionId, setExpandedSuggestionId] = useState<string | null>(null);

  const handleSuggestionClick = (suggestion: Suggestion) => {
    const nextExpandedId = expandedSuggestionId === suggestion.id ? null : suggestion.id;

    setExpandedSuggestionId(nextExpandedId);

    if (nextExpandedId) {
      onSuggestionSelected?.(suggestion);
    }
  };

  return (
    <section
      aria-label="Suggestions panel"
      className="soft-panel flex h-full min-h-0 flex-col rounded-[2rem] p-6"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Suggestions
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            Live suggestions engine
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-teal-700 px-3 py-1 text-xs font-semibold text-white shadow-sm">
            {suggestionBatches.length} batches
          </span>
          <button
            aria-label="Refresh suggestions"
            className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoading}
            type="button"
            onClick={onRefresh}
          >
            {isLoading ? <span aria-hidden="true" className="subtle-spinner" /> : null}
            ↻ Refresh Suggestions
          </button>
        </div>
      </div>

      {isLoading ? (
        <div
          aria-live="polite"
          className="mb-4 flex items-center gap-3 rounded-[1.25rem] border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-700"
        >
          <span aria-hidden="true" className="subtle-spinner" />
          <p>Generating suggestions...</p>
        </div>
      ) : null}

      {error ? (
        <p className="mb-4 rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Failed to generate suggestions. Check API key.
        </p>
      ) : null}

      <div className="panel-scroll flex-1 space-y-4 overflow-y-auto pr-1">
        {suggestionBatches.length === 0 ? (
          <article className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50/80 p-4">
            <p className="text-sm leading-6 text-slate-500">
              Suggestions will appear here every 30 seconds once fresh transcript context is
              available, or immediately when you press refresh.
            </p>
          </article>
        ) : null}

        {suggestionBatches.map((batch) => (
          <article
            key={batch.id}
            className="rounded-[1.5rem] border border-slate-200 bg-slate-50/90 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-950">Batch generated</p>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                {format(batch.timestamp, "HH:mm:ss")}
              </p>
            </div>

            <div className="space-y-3">
              {batch.suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  aria-expanded={expandedSuggestionId === suggestion.id}
                  className="w-full rounded-[1.25rem] border border-slate-200 bg-white/95 p-4 text-left shadow-sm hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_14px_40px_rgba(15,23,42,0.08)]"
                  type="button"
                  onClick={() => handleSuggestionClick(suggestion)}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                      <span
                        className={`inline-flex w-fit shrink-0 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${toneByType[suggestion.type]}`}
                      >
                        {iconByType[suggestion.type]} {suggestion.type.replace("_", " ")}
                      </span>
                      <p className="text-sm font-medium leading-6 text-slate-800">
                        {suggestion.preview}
                      </p>
                    </div>
                    <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                      {expandedSuggestionId === suggestion.id ? "Hide" : "Expand"}
                    </span>
                  </div>
                  {expandedSuggestionId === suggestion.id ? (
                    <div className="mt-3 border-t border-slate-200 pt-3">
                      <p className="text-sm leading-7 text-slate-600">{suggestion.full_content}</p>
                      <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">
                        Sent to chat for a detailed answer
                      </p>
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
