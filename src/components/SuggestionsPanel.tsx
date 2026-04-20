"use client";

import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { format } from "date-fns";
import type { Suggestion, SuggestionBatch, SuggestionMeta } from "@/lib/types";

type SuggestionsPanelProps = {
  error: string | null;
  isLoading: boolean;
  isRefreshingTranscript?: boolean;
  onCopySuggestion?: (suggestion: Suggestion) => void;
  onDismissSuggestion?: (suggestion: Suggestion) => void;
  onOpenSettings?: () => void;
  onRefresh: () => void;
  onSuggestionSelected?: (suggestion: Suggestion, meta?: SuggestionMeta) => void;
  suggestionBatches: SuggestionBatch[];
};

type SuggestionContextMenuState = {
  suggestion: Suggestion;
  meta?: SuggestionMeta;
  x: number;
  y: number;
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

const SuggestionCard = memo(function SuggestionCard({
  expanded,
  onContextMenu,
  onLongPress,
  onClick,
  suggestion,
}: {
  expanded: boolean;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>, suggestion: Suggestion) => void;
  onLongPress: (suggestion: Suggestion, target: HTMLElement) => void;
  onClick: () => void;
  suggestion: Suggestion;
}) {
  const longPressTimeoutRef = useRef<number | null>(null);

  const clearLongPress = () => {
    if (longPressTimeoutRef.current !== null) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  return (
    <button
      aria-expanded={expanded}
      className="w-full rounded-[1.25rem] border border-slate-200 bg-white/95 p-4 text-left shadow-sm transition hover:-translate-y-[2px] hover:border-slate-300 hover:shadow-[0_18px_50px_rgba(15,23,42,0.1)]"
      type="button"
      onClick={onClick}
      onContextMenu={(event) => onContextMenu(event, suggestion)}
      onPointerCancel={clearLongPress}
      onPointerDown={(event) => {
        clearLongPress();
        const target = event.currentTarget;

        longPressTimeoutRef.current = window.setTimeout(() => {
          onLongPress(suggestion, target);
          longPressTimeoutRef.current = null;
        }, 450);
      }}
      onPointerLeave={clearLongPress}
      onPointerUp={clearLongPress}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={`inline-flex w-fit shrink-0 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${toneByType[suggestion.type]}`}
          >
            {iconByType[suggestion.type]} {suggestion.type.replace("_", " ")}
          </span>
          <p className="text-sm font-medium leading-6 text-slate-800">{suggestion.preview}</p>
        </div>
        <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
          {expanded ? "Hide" : "Expand"}
        </span>
      </div>
      {expanded ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <p className="text-sm leading-7 text-slate-600">{suggestion.full_content}</p>
          {suggestion.evidence_quote ? (
            <div className="mt-3 rounded-[1rem] bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Evidence quote
              </p>
              <p className="mt-1 text-sm font-medium leading-6 text-slate-700">
                &quot;{suggestion.evidence_quote}&quot;
              </p>
              {suggestion.why_relevant ? (
                <p className="mt-1 text-xs leading-5 text-slate-500">{suggestion.why_relevant}</p>
              ) : null}
            </div>
          ) : null}
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">
            Sent to chat for a detailed answer
          </p>
        </div>
      ) : null}
    </button>
  );
});

export function SuggestionsPanel({
  error,
  isLoading,
  isRefreshingTranscript,
  onCopySuggestion,
  onDismissSuggestion,
  onOpenSettings,
  onRefresh,
  onSuggestionSelected,
  suggestionBatches,
}: SuggestionsPanelProps) {
  const [expandedSuggestionId, setExpandedSuggestionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SuggestionContextMenuState | null>(null);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());
  const isApiKeyError = useMemo(() => error?.toLowerCase().includes("api key") ?? false, [error]);
  const statusLabel = error
    ? "Error"
    : isLoading
      ? "Loading"
      : suggestionBatches.length === 0
        ? "Idle"
        : "Success";
  const statusClassName = error
    ? "bg-rose-100 text-rose-700"
    : isLoading
      ? "bg-sky-100 text-sky-700"
      : suggestionBatches.length === 0
        ? "bg-slate-200 text-slate-700"
        : "bg-emerald-100 text-emerald-700";

  useEffect(() => {
    const handleCloseMenu = () => {
      setContextMenu(null);
    };

    window.addEventListener("click", handleCloseMenu);
    window.addEventListener("scroll", handleCloseMenu, true);

    return () => {
      window.removeEventListener("click", handleCloseMenu);
      window.removeEventListener("scroll", handleCloseMenu, true);
    };
  }, []);

  const handleSuggestionClick = (suggestion: Suggestion, meta?: SuggestionMeta) => {
    const nextExpandedId = expandedSuggestionId === suggestion.id ? null : suggestion.id;

    setExpandedSuggestionId(nextExpandedId);

    if (nextExpandedId) {
      onSuggestionSelected?.(suggestion, meta);
    }
  };

  const openContextMenu = (suggestion: Suggestion, x: number, y: number, meta?: SuggestionMeta) => {
    setContextMenu({
      suggestion,
      meta,
      x,
      y,
    });
  };

  const visibleBatches = useMemo(
    () =>
      suggestionBatches
        .map((batch) => ({
          ...batch,
          suggestions: batch.suggestions.filter(
            (suggestion) => !dismissedSuggestionIds.has(suggestion.id),
          ),
        }))
        .filter((batch) => batch.suggestions.length > 0),
    [dismissedSuggestionIds, suggestionBatches],
  );

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
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Suggestions surface every 30 seconds with grounded next steps, clarifications, or ready-to-use answers.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold shadow-sm ${statusClassName}`}>
            {statusLabel}
          </span>
          <span className="rounded-full bg-teal-700 px-3 py-1 text-xs font-semibold text-white shadow-sm">
            {visibleBatches.length} batches
          </span>
          {isRefreshingTranscript ? (
            <span className="text-xs font-medium text-slate-400">Updating transcript…</span>
          ) : null}
          <button
            aria-label="Refresh suggestions"
            className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isLoading || isRefreshingTranscript}
            type="button"
            onClick={onRefresh}
          >
            {isLoading ? <span aria-hidden="true" className="subtle-spinner" /> : null}
            ↻ Refresh Suggestions
          </button>
        </div>
      </div>

      {isLoading ? (
        <div aria-live="polite" className="mb-4 space-y-3">
          <div className="flex items-center gap-3 rounded-[1.25rem] border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-700">
            <span aria-hidden="true" className="subtle-spinner" />
            <p>Generating suggestions...</p>
          </div>
          <div className="grid gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <article
                key={`suggestion-skeleton-${index}`}
                aria-hidden="true"
                className="rounded-[1.25rem] border border-slate-200 bg-white/95 p-4 shadow-sm"
              >
                <div className="h-5 w-28 animate-pulse rounded-full bg-slate-200" />
                <div className="mt-4 space-y-2">
                  <div className="h-4 w-full animate-pulse rounded-full bg-slate-200" />
                  <div className="h-4 w-4/5 animate-pulse rounded-full bg-slate-200" />
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <p>{error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded-full border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:border-rose-500 hover:text-rose-800"
              type="button"
              onClick={onRefresh}
            >
              Retry
            </button>
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

      <div className="panel-scroll flex-1 space-y-4 overflow-y-auto pr-1">
        {visibleBatches.length === 0 ? (
          <article className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50/80 p-4">
            <p className="text-sm leading-6 text-slate-500">
              Suggestions appear every 30 seconds during a conversation. You can also refresh manually.
            </p>
          </article>
        ) : null}

        {visibleBatches.map((batch, batchIndex) => (
          <article
            key={batch.id}
            className={`rounded-[1.5rem] border border-slate-200 bg-slate-50/90 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)] ${batchIndex === 0 ? "animate-batch-in" : ""}`}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-950">Batch generated</p>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                {format(batch.timestamp, "HH:mm:ss")}
              </p>
            </div>

            <div className="space-y-3">
              {batch.suggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  expanded={expandedSuggestionId === suggestion.id}
                  onContextMenu={(event, selectedSuggestion) => {
                    event.preventDefault();
                    openContextMenu(selectedSuggestion, event.clientX, event.clientY, batch.meta);
                  }}
                  onLongPress={(selectedSuggestion, target) => {
                    const rect = target.getBoundingClientRect();
                    openContextMenu(
                      selectedSuggestion,
                      rect.left + rect.width / 2,
                      rect.top + 24,
                      batch.meta,
                    );
                  }}
                  suggestion={suggestion}
                  onClick={() => handleSuggestionClick(suggestion, batch.meta)}
                />
              ))}
            </div>
          </article>
        ))}
      </div>

      <p className="mt-4 text-xs uppercase tracking-[0.16em] text-slate-400">
        AI-generated · review before sharing
      </p>

      {contextMenu ? (
        <div
          className="fixed z-[55] min-w-[200px] rounded-[1.25rem] border border-slate-200 bg-white/97 p-2 shadow-[0_24px_70px_rgba(15,23,42,0.18)] backdrop-blur"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 220),
            top: Math.min(contextMenu.y, window.innerHeight - 180),
          }}
        >
          <button
            className="flex w-full items-center rounded-[0.9rem] px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
            type="button"
            onClick={() => {
              onCopySuggestion?.(contextMenu.suggestion);
              setContextMenu(null);
            }}
          >
            Copy preview
          </button>
          <button
            className="flex w-full items-center rounded-[0.9rem] px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
            type="button"
            onClick={() => {
              setExpandedSuggestionId(contextMenu.suggestion.id);
              onSuggestionSelected?.(contextMenu.suggestion, contextMenu.meta);
              setContextMenu(null);
            }}
          >
            Ask detailed answer
          </button>
          <button
            className="flex w-full items-center rounded-[0.9rem] px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
            type="button"
            onClick={() => {
              setDismissedSuggestionIds((currentIds) => new Set(currentIds).add(contextMenu.suggestion.id));
              onDismissSuggestion?.(contextMenu.suggestion);
              setContextMenu(null);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}
