"use client";

import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { format } from "date-fns";
import type { Suggestion, SuggestionBatch, SuggestionMeta } from "@/lib/types";

type SuggestionsPanelProps = {
  countdownSeconds?: number | null;
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

const badgeByType: Partial<
  Record<Suggestion["type"], { className: string; label: string }>
> = {
  question: {
    className: "badge badge-q",
    label: "Question to Ask",
  },
  talking_point: {
    className: "badge badge-tp",
    label: "Talking Point",
  },
  fact_check: {
    className: "badge badge-fc",
    label: "Fact-Check",
  },
  clarification: {
    className: "badge badge-cl",
    label: "Clarify",
  },
};

const SuggestionCard = memo(function SuggestionCard({
  animationIndex,
  expanded,
  onContextMenu,
  onCopy,
  onDismiss,
  onLongPress,
  onSendToChat,
  onSelect,
  suggestion,
}: {
  animationIndex: number;
  expanded: boolean;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, suggestion: Suggestion) => void;
  onCopy: () => void;
  onDismiss: () => void;
  onLongPress: (suggestion: Suggestion, target: HTMLElement) => void;
  onSendToChat: () => void;
  onSelect: () => void;
  suggestion: Suggestion;
}) {
  const longPressTimeoutRef = useRef<number | null>(null);
  const badge = badgeByType[suggestion.type];

  const clearLongPress = () => {
    if (longPressTimeoutRef.current !== null) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  return (
    <div
      aria-expanded={expanded}
      aria-label={suggestion.preview}
      className="suggestion-card"
      role="button"
      style={{ animationDelay: `${Math.min(animationIndex, 6) * 60}ms` }}
      tabIndex={0}
      onClick={onSelect}
      onContextMenu={(event) => onContextMenu(event, suggestion)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
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
      {badge ? (
        <span className={badge.className}>
          <span className="badge-dot" />
          {badge.label}
        </span>
      ) : null}

      <p className={badge ? "card-text" : "suggestion-plain"}>{suggestion.preview}</p>

      {expanded ? (
        <div className="suggestion-expand">
          <p className="text-[12.5px] leading-[1.65] text-[var(--text-mid)]">
            {suggestion.full_content}
          </p>
          {suggestion.evidence_quote ? (
            <div className="suggestion-evidence">
              <p className="suggestion-evidence-label">Evidence quote</p>
              <p className="suggestion-evidence-quote">&quot;{suggestion.evidence_quote}&quot;</p>
              {suggestion.why_relevant ? (
                <p className="suggestion-evidence-why">{suggestion.why_relevant}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="suggestion-actions">
        <button
          className="suggestion-action-btn"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCopy();
          }}
        >
          Copy
        </button>
        <button
          className="suggestion-action-btn"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSendToChat();
          }}
        >
          Ask
        </button>
        <button
          className="suggestion-action-btn"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
});

export function SuggestionsPanel({
  countdownSeconds,
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
  const [isReloadSpinning, setIsReloadSpinning] = useState(false);
  const isApiKeyError = useMemo(() => error?.toLowerCase().includes("api key") ?? false, [error]);

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

  const visibleBatches = useMemo(
    () =>
      suggestionBatches
        .map((batch, index) => ({
          ...batch,
          displayIndex: suggestionBatches.length - index,
          suggestions: batch.suggestions.filter(
            (suggestion) => !dismissedSuggestionIds.has(suggestion.id),
          ),
        }))
        .filter((batch) => batch.suggestions.length > 0),
    [dismissedSuggestionIds, suggestionBatches],
  );

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

  const handleRefreshClick = () => {
    setIsReloadSpinning(true);
    window.setTimeout(() => setIsReloadSpinning(false), 600);
    onRefresh();
  };

  return (
    <section aria-label="Suggestions panel" className="flex h-full min-h-0 flex-col">
      <div className="col-body col-scroll">
        <div className="suggestions-toolbar">
          <button
            aria-label="Reload suggestions"
            className="reload-btn"
            disabled={isLoading || isRefreshingTranscript}
            type="button"
            onClick={handleRefreshClick}
          >
            <span className={`reload-icon ${isReloadSpinning ? "spinning" : ""}`}>↺</span>
            Reload
          </button>

          <span className="auto-tag">
            <span className="auto-dot" />
            {isRefreshingTranscript
              ? "Updating transcript…"
              : isLoading
                ? "Refreshing…"
                : `auto-refresh ${typeof countdownSeconds === "number" ? `${countdownSeconds}s` : "—"}`}
          </span>
        </div>

        {isLoading ? (
          <div className="mb-3 space-y-2">
            {Array.from({ length: 3 }, (_, index) => (
              <article
                key={`suggestion-skeleton-${index}`}
                aria-hidden="true"
                className="suggestion-card text-[var(--surface2)]"
              >
                <div className="h-4 w-24 rounded-full skeleton-shimmer bg-current" />
                <div className="mt-3 space-y-2">
                  <div className="h-3 w-full rounded-full skeleton-shimmer bg-current" />
                  <div className="h-3 w-4/5 rounded-full skeleton-shimmer bg-current" />
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {error ? (
          <div className="mb-3 rounded-[var(--radius)] border border-[rgba(248,113,113,.22)] bg-[rgba(248,113,113,.08)] px-3 py-2 text-[11px] leading-[1.55] text-[var(--rose)]">
            <p>{error}</p>
            <div className="mt-2 flex items-center gap-3">
              <button
                className="suggestion-action-btn !text-[var(--rose)]"
                type="button"
                onClick={onRefresh}
              >
                Retry
              </button>
              {isApiKeyError && onOpenSettings ? (
                <button
                  className="suggestion-action-btn !text-[var(--rose)]"
                  type="button"
                  onClick={onOpenSettings}
                >
                  Open Settings
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {visibleBatches.length === 0 ? (
          <div className="text-[12px] leading-[1.6] text-[var(--text-dim)]">
            Suggestions appear here every 30 seconds while the conversation is active.
          </div>
        ) : null}

        {visibleBatches.map((batch, batchIndex) => (
          <article key={batch.id}>
            {batchIndex > 0 ? (
              <div className="batch-divider">
                <span>
                  Batch {batch.displayIndex} · {format(batch.timestamp, "HH:mm:ss")}
                </span>
              </div>
            ) : null}

            {batch.suggestions.map((suggestion, suggestionIndex) => (
              <SuggestionCard
                key={suggestion.id}
                animationIndex={batchIndex * 3 + suggestionIndex}
                expanded={expandedSuggestionId === suggestion.id}
                onContextMenu={(event, selectedSuggestion) => {
                  event.preventDefault();
                  openContextMenu(selectedSuggestion, event.clientX, event.clientY, batch.meta);
                }}
                onCopy={() => onCopySuggestion?.(suggestion)}
                onDismiss={() => {
                  setDismissedSuggestionIds((currentIds) => new Set(currentIds).add(suggestion.id));
                  onDismissSuggestion?.(suggestion);
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
                onSendToChat={() => {
                  setExpandedSuggestionId(suggestion.id);
                  onSuggestionSelected?.(suggestion, batch.meta);
                }}
                onSelect={() => handleSuggestionClick(suggestion, batch.meta)}
                suggestion={suggestion}
              />
            ))}
          </article>
        ))}
      </div>

      {contextMenu ? (
        <div
          className="fixed z-[55] min-w-[180px] rounded-[var(--radius)] border border-[var(--border2)] bg-[var(--bg2)] p-1.5 shadow-[0_12px_30px_rgba(0,0,0,.35)]"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 160),
          }}
        >
          <button
            className="flex w-full items-center rounded-[var(--radius)] px-2.5 py-2 text-[11px] text-[var(--text-mid)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
            type="button"
            onClick={() => {
              onCopySuggestion?.(contextMenu.suggestion);
              setContextMenu(null);
            }}
          >
            Copy preview
          </button>
          <button
            className="flex w-full items-center rounded-[var(--radius)] px-2.5 py-2 text-[11px] text-[var(--text-mid)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
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
            className="flex w-full items-center rounded-[var(--radius)] px-2.5 py-2 text-[11px] text-[var(--text-mid)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
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
