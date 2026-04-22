"use client";

import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { format } from "date-fns";
import type { SuggestionSkipState, StreamingBatchState } from "@/hooks/useSuggestions";
import type {
  MeetingWrapUp,
  Suggestion,
  SuggestionBatch,
  SuggestionMeta,
  SuggestionType,
} from "@/lib/types";

type SuggestionsPanelProps = {
  countdownSeconds?: number | null;
  error: string | null;
  isLoading: boolean;
  isGeneratingWrapUp?: boolean;
  isRecording?: boolean;
  isRefreshingTranscript?: boolean;
  isMuted: (type: SuggestionType) => boolean;
  isPinned: (id: string) => boolean;
  mutedTypes: Set<SuggestionType>;
  onCopySuggestion?: (suggestion: Suggestion) => void;
  onDismissSuggestion?: (suggestion: Suggestion) => void;
  onJumpToTimestamp?: (timestamp: string) => void;
  onNewSession: () => void;
  onRefresh: () => void;
  onSuggestionSelected?: (suggestion: Suggestion, meta?: SuggestionMeta) => void;
  pinnedIds: string[];
  pinnedSuggestions: Suggestion[];
  resolveTimestampForSuggestion?: (suggestion: Suggestion) => string | null;
  skipState?: SuggestionSkipState | null;
  streamingBatches: Map<string, StreamingBatchState>;
  suggestionBatches: SuggestionBatch[];
  toggleMuteType: (type: SuggestionType) => void;
  togglePin: (id: string, suggestion: Suggestion) => void;
  wrapUp?: MeetingWrapUp | null;
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

const filterChipByType: Record<SuggestionType, { className: string; label: string }> = {
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
  answer: {
    className: "badge badge-answer",
    label: "Answer",
  },
};

const suggestionTypeOrder: SuggestionType[] = [
  "question",
  "talking_point",
  "fact_check",
  "clarification",
  "answer",
];

const QUIET_QUOTES = [
  "Listening quietly — nothing new to riff on yet.",
  "All ears. Waiting for something worth flagging.",
  "The room got thoughtful. Staying out of the way.",
  "No new signal. Still watching.",
  "Silence is data too. Standing by.",
] as const;

const ECHO_QUOTES = [
  "That thread's still looping — waiting for a new angle.",
  "Same ground being re-tilled. Holding until the topic moves.",
  "Still circling. I'll jump in when the conversation turns.",
  "Deja vu detected. Saving suggestions for something fresh.",
] as const;

const getSourceDomain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const PinIcon = ({ pinned }: { pinned: boolean }) => (
  <svg
    aria-hidden="true"
    className="h-[14px] w-[14px]"
    fill={pinned ? "currentColor" : "none"}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.8"
    viewBox="0 0 24 24"
  >
    <path d="M12 2L15 8L21 9L17 14L18 20L12 17L6 20L7 14L3 9L9 8Z" />
  </svg>
);

const SkipCard = ({
  quote,
}: {
  quote: string;
}) => (
  <article aria-live="polite" className="suggestion-card suggestion-skip-card">
    <div className="ambient-card-body">
      <p className="ambient-quote">{quote}</p>
      <div aria-hidden="true" className="ambient-dots">
        <span className="ambient-dot" />
        <span className="ambient-dot" />
        <span className="ambient-dot" />
      </div>
    </div>
  </article>
);

const WrapUpCard = ({
  isGenerating,
  onNewSession,
  wrapUp,
}: {
  isGenerating: boolean;
  onNewSession: () => void;
  wrapUp?: MeetingWrapUp | null;
}) => (
  <article aria-live="polite" className="suggestion-card wrap-up-card">
    <div className="wrap-up-title-row">
      <span aria-hidden="true" className="wrap-up-accent-dot" />
      <span className="wrap-up-title">Meeting wrap-up</span>
    </div>

    {isGenerating && !wrapUp ? (
      <div className="ambient-card-body wrap-up-loading">
        <p className="ambient-quote">Wrapping up…</p>
        <div aria-hidden="true" className="ambient-dots">
          <span className="ambient-dot" />
          <span className="ambient-dot" />
          <span className="ambient-dot" />
        </div>
      </div>
    ) : wrapUp ? (
      <>
        <p className="wrap-up-gist">{wrapUp.gist}</p>
        <div className="wrap-up-divider" />
        <p className="wrap-up-topics-label">Topics covered</p>
        <div className="wrap-up-topic-list">
          {wrapUp.agenda.map((item) => (
            <div key={`${wrapUp.generated_at}-${item}`} className="wrap-up-topic-chip">
              {item}
            </div>
          ))}
        </div>
        <button className="wrap-up-action-btn" type="button" onClick={onNewSession}>
          New session
        </button>
      </>
    ) : null}
  </article>
);

const SuggestionCard = memo(function SuggestionCard({
  animationIndex,
  animated,
  expanded,
  evidenceTimestamp,
  onContextMenu,
  onCopy,
  onDismiss,
  onJumpToTimestamp,
  onLongPress,
  onSendToChat,
  onSelect,
  onTogglePin,
  onToggleWhy,
  pinned,
  suggestion,
  whyExpanded,
}: {
  animationIndex: number;
  animated?: boolean;
  expanded: boolean;
  evidenceTimestamp?: string | null;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, suggestion: Suggestion) => void;
  onCopy: () => void;
  onDismiss: () => void;
  onJumpToTimestamp?: (timestamp: string) => void;
  onLongPress: (suggestion: Suggestion, target: HTMLElement) => void;
  onSendToChat: () => void;
  onSelect: () => void;
  onTogglePin: () => void;
  onToggleWhy: () => void;
  pinned: boolean;
  suggestion: Suggestion;
  whyExpanded: boolean;
}) {
  const longPressTimeoutRef = useRef<number | null>(null);
  const badge = badgeByType[suggestion.type];
  const whyPanelId = `card-why-${suggestion.id}`;
  const sourceDomain = suggestion.source_url ? getSourceDomain(suggestion.source_url) : null;

  const clearLongPress = () => {
    if (longPressTimeoutRef.current !== null) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  return (
    <div
      aria-expanded={expanded}
      aria-label={`${suggestion.preview}${suggestion.conviction === "medium" ? " (lower confidence)" : ""}`}
      className={`suggestion-card${suggestion.conviction === "medium" ? " suggestion-card--medium" : ""}${animated === false ? "" : " is-animated"}`}
      role="button"
      style={
        animated === false ? undefined : { animationDelay: `${Math.min(animationIndex, 6) * 60}ms` }
      }
      tabIndex={0}
      onClick={onSelect}
      onContextMenu={(event) => onContextMenu(event, suggestion)}
      onKeyDown={(event) => {
        if ((event.key === "?" || (event.key === "/" && event.shiftKey)) && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onToggleWhy();
          return;
        }

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
      <button
        aria-label={pinned ? "Unpin suggestion" : "Pin suggestion"}
        aria-pressed={pinned}
        className={`suggestion-pin-btn${pinned ? " is-pinned" : ""}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin();
        }}
      >
        <PinIcon pinned={pinned} />
      </button>

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
          {suggestion.selection_reason ? (
            <div className="suggestion-evidence suggestion-evidence-selection">
              <p className="suggestion-evidence-label">Why this one</p>
              <p className="suggestion-evidence-why">{suggestion.selection_reason}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {suggestion.source_url ? (
        <a
          aria-label={`Open source: ${suggestion.source_title ?? suggestion.source_url}`}
          className="suggestion-source-chip"
          href={suggestion.source_url}
          rel="noopener noreferrer"
          target="_blank"
          onClick={(event) => event.stopPropagation()}
        >
          ↗ {sourceDomain}
        </a>
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
        <button
          aria-controls={whyPanelId}
          aria-expanded={whyExpanded}
          className="suggestion-why-toggle"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleWhy();
          }}
        >
          Why this?
        </button>
      </div>

      <div
        aria-hidden={!whyExpanded}
        aria-label="Why this suggestion"
        className={`suggestion-why-panel${whyExpanded ? " open" : ""}`}
        id={whyPanelId}
        role="region"
      >
        <div className="suggestion-why-row">
          <span className="suggestion-why-label">Heard at</span>
          <div className="suggestion-why-content">
            {evidenceTimestamp ? (
              <button
                className="suggestion-why-timestamp"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onJumpToTimestamp?.(evidenceTimestamp);
                }}
              >
                {evidenceTimestamp}
              </button>
            ) : (
              <span className="suggestion-why-timestamp is-muted">—</span>
            )}
            <p className="suggestion-why-quote">&quot;{suggestion.evidence_quote}&quot;</p>
          </div>
        </div>

        <div className="suggestion-why-row">
          <span className="suggestion-why-label">Why suggest this</span>
          <p className="suggestion-why-copy">{suggestion.rationale}</p>
        </div>

        {suggestion.selection_reason ? (
          <div className="suggestion-why-row">
            <span className="suggestion-why-label">Why this card won</span>
            <p className="suggestion-why-copy">{suggestion.selection_reason}</p>
          </div>
        ) : null}

        {suggestion.source_url ? (
          <div className="suggestion-why-row">
            <span className="suggestion-why-label">Source</span>
            <div className="suggestion-why-source">
              <div className="suggestion-why-source-copy">
                <span className="suggestion-why-source-title">
                  {sourceDomain
                    ? `${sourceDomain} · ${suggestion.source_title ?? "Source"}`
                    : suggestion.source_title ?? suggestion.source_url}
                </span>
                <a
                  className="suggestion-why-source-link"
                  href={suggestion.source_url}
                  rel="noopener noreferrer"
                  target="_blank"
                  onClick={(event) => event.stopPropagation()}
                >
                  {suggestion.source_url}
                </a>
                {suggestion.source_scope ? (
                  <p className="suggestion-why-source-scope">
                    Scoped to: &quot;{suggestion.source_scope}&quot;
                    {evidenceTimestamp ? ` (from transcript at ${evidenceTimestamp})` : ""}
                  </p>
                ) : null}
              </div>
              <button
                className="suggestion-source-copy-btn"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void navigator.clipboard.writeText(suggestion.source_url ?? "");
                }}
              >
                Copy
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function SuggestionsPanel({
  countdownSeconds,
  error,
  isLoading,
  isGeneratingWrapUp = false,
  isRecording = false,
  isRefreshingTranscript,
  isMuted,
  isPinned,
  mutedTypes,
  onCopySuggestion,
  onDismissSuggestion,
  onJumpToTimestamp,
  onNewSession,
  onRefresh,
  onSuggestionSelected,
  pinnedIds,
  pinnedSuggestions,
  resolveTimestampForSuggestion,
  skipState = null,
  streamingBatches,
  suggestionBatches,
  toggleMuteType,
  togglePin,
  wrapUp = null,
}: SuggestionsPanelProps) {
  const [expandedSuggestionId, setExpandedSuggestionId] = useState<string | null>(null);
  const [openWhySuggestionId, setOpenWhySuggestionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SuggestionContextMenuState | null>(null);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());
  const [isReloadSpinning, setIsReloadSpinning] = useState(false);
  const [quoteTick, setQuoteTick] = useState(0);

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

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setQuoteTick((current) => current + 1);
    }, 10_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const visibleBatches = useMemo(() => {
      const batches = suggestionBatches.map((batch, index) => {
        const filteredSuggestions = batch.suggestions.filter(
          (suggestion) =>
            !dismissedSuggestionIds.has(suggestion.id) && !mutedTypes.has(suggestion.type),
        );

        return {
          ...batch,
          displayIndex: suggestionBatches.length - index,
          filteredSuggestions,
          isMutedPlaceholder:
            batch.suggestions.length > 0 &&
            filteredSuggestions.length === 0 &&
            batch.suggestions.some((suggestion) => !dismissedSuggestionIds.has(suggestion.id)),
        };
      }).filter((batch) => batch.filteredSuggestions.length > 0 || batch.isMutedPlaceholder);

      // Dev-only: warn if any duplicate batch.id or suggestion.id slipped through.
      if (process.env.NODE_ENV !== "production") {
        const seenBatchIds = new Set<string>();
        const seenCardIds = new Set<string>();
        for (const batch of batches) {
          if (seenBatchIds.has(batch.id)) {
            console.warn("[SuggestionsPanel] duplicate batch.id detected", { id: batch.id });
          }
          seenBatchIds.add(batch.id);
          for (const suggestion of batch.filteredSuggestions) {
            if (seenCardIds.has(suggestion.id)) {
              console.warn("[SuggestionsPanel] duplicate suggestion.id detected", { id: suggestion.id });
            }
            seenCardIds.add(suggestion.id);
          }
        }
      }

      return batches;
    },
    [dismissedSuggestionIds, mutedTypes, suggestionBatches],
  );

  const activeStreamingBatches = useMemo(
    () =>
      Array.from(streamingBatches.values()).filter(
        (batch) => !(batch.status === "error" && batch.suggestions.length === 0),
      ),
    [streamingBatches],
  );

  const filteredStreamingBatches = useMemo(
    () =>
      activeStreamingBatches
        .map((batch) => ({
          ...batch,
          suggestions: batch.suggestions.filter(
            (suggestion) =>
              !dismissedSuggestionIds.has(suggestion.id) && !mutedTypes.has(suggestion.type),
          ),
        }))
        .filter((batch) => batch.suggestions.length > 0)
        .sort((a, b) => b.startedAt - a.startedAt),
    [activeStreamingBatches, dismissedSuggestionIds, mutedTypes],
  );

  const hasVisibleBatches = visibleBatches.length > 0;
  const hasActiveStreamingBatch = activeStreamingBatches.length > 0;
  const shouldShowWrapUp = !isRecording && (isGeneratingWrapUp || wrapUp !== null);
  const shouldShowSkip = skipState !== null && !hasVisibleBatches && !hasActiveStreamingBatch;
  const hasRenderableContent =
    shouldShowWrapUp ||
    pinnedSuggestions.length > 0 ||
    filteredStreamingBatches.length > 0 ||
    hasVisibleBatches ||
    shouldShowSkip;
  const skipQuotePool = skipState?.reason === "echo" ? ECHO_QUOTES : QUIET_QUOTES;
  const ambientQuote = skipState ? skipQuotePool[quoteTick % skipQuotePool.length] : null;

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

  const handleDismiss = (suggestion: Suggestion) => {
    setDismissedSuggestionIds((currentIds) => new Set(currentIds).add(suggestion.id));
    if (isPinned(suggestion.id)) {
      togglePin(suggestion.id, suggestion);
    }
    onDismissSuggestion?.(suggestion);
  };

  return (
    <section aria-label="Suggestions panel" className="flex h-full min-h-0 flex-col">
      <div className="col-body col-scroll">
        <div className="suggestion-mute-row tab-scroller">
          {suggestionTypeOrder.map((type) => {
            const presentation = filterChipByType[type];
            const muted = isMuted(type);

            return (
              <button
                key={type}
                aria-pressed={!muted}
                className={`${presentation.className} mute-chip${muted ? " is-muted" : ""}`}
                type="button"
                onClick={() => toggleMuteType(type)}
              >
                <span className="badge-dot" />
                {presentation.label}
              </button>
            );
          })}
        </div>

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

        {!shouldShowWrapUp && isLoading && filteredStreamingBatches.length === 0 ? (
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

        {!shouldShowWrapUp && pinnedIds.length > 0 ? (
          <section className="pinned-strip">
            <div className="batch-divider pinned-divider">
              <span>📌 Pinned · {pinnedIds.length}</span>
            </div>

            {pinnedSuggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                animated={false}
                animationIndex={0}
                evidenceTimestamp={resolveTimestampForSuggestion?.(suggestion) ?? null}
                expanded={expandedSuggestionId === suggestion.id}
                onContextMenu={(event, selectedSuggestion) => {
                  event.preventDefault();
                  openContextMenu(selectedSuggestion, event.clientX, event.clientY);
                }}
                onCopy={() => onCopySuggestion?.(suggestion)}
                onDismiss={() => {
                  handleDismiss(suggestion);
                }}
                onJumpToTimestamp={onJumpToTimestamp}
                onLongPress={(selectedSuggestion, target) => {
                  const rect = target.getBoundingClientRect();
                  openContextMenu(
                    selectedSuggestion,
                    rect.left + rect.width / 2,
                    rect.top + 24,
                  );
                }}
                onSendToChat={() => {
                  setExpandedSuggestionId(suggestion.id);
                  onSuggestionSelected?.(suggestion);
                }}
                onSelect={() => handleSuggestionClick(suggestion)}
                onTogglePin={() => togglePin(suggestion.id, suggestion)}
                onToggleWhy={() => {
                  setOpenWhySuggestionId((currentId) =>
                    currentId === suggestion.id ? null : suggestion.id,
                  );
                }}
                pinned
                suggestion={suggestion}
                whyExpanded={openWhySuggestionId === suggestion.id}
              />
            ))}
          </section>
        ) : null}

        {shouldShowWrapUp ? (
          <WrapUpCard isGenerating={isGeneratingWrapUp} onNewSession={onNewSession} wrapUp={wrapUp} />
        ) : null}

        {hasActiveStreamingBatch
          ? filteredStreamingBatches.map((streamingBatch) => (
          <article key={streamingBatch.batchId}>
            <div className="batch-divider">
              <span className="inline-flex items-center gap-2">
                <span className="streaming-dot" aria-hidden="true" />
                {streamingBatch.status === "ranking"
                  ? `Ranking ${streamingBatch.candidateCount ?? 6} candidates…`
                  : "Streaming…"}
                {streamingBatch.status === "retrying" ? (
                  <span className="refining-chip">Refining…</span>
                ) : null}
                {streamingBatch.slowStream && streamingBatch.status === "streaming" ? (
                  <span className="slow-stream-chip">Slow stream</span>
                ) : null}
              </span>
            </div>

            {streamingBatch.suggestions.map((suggestion, suggestionIndex) => (
              <SuggestionCard
                key={suggestion.id}
                animationIndex={suggestionIndex}
                expanded={expandedSuggestionId === suggestion.id}
                onContextMenu={(event, selectedSuggestion) => {
                  event.preventDefault();
                  openContextMenu(
                    selectedSuggestion,
                    event.clientX,
                    event.clientY,
                    streamingBatch.meta,
                  );
                }}
                evidenceTimestamp={resolveTimestampForSuggestion?.(suggestion) ?? null}
                onCopy={() => onCopySuggestion?.(suggestion)}
                onDismiss={() => {
                  handleDismiss(suggestion);
                  if (openWhySuggestionId === suggestion.id) {
                    setOpenWhySuggestionId(null);
                  }
                }}
                onJumpToTimestamp={onJumpToTimestamp}
                onLongPress={(selectedSuggestion, target) => {
                  const rect = target.getBoundingClientRect();
                  openContextMenu(
                    selectedSuggestion,
                    rect.left + rect.width / 2,
                    rect.top + 24,
                    streamingBatch.meta,
                  );
                }}
                onSendToChat={() => {
                  setExpandedSuggestionId(suggestion.id);
                  onSuggestionSelected?.(suggestion, streamingBatch.meta);
                }}
                onSelect={() => handleSuggestionClick(suggestion, streamingBatch.meta)}
                onTogglePin={() => togglePin(suggestion.id, suggestion)}
                onToggleWhy={() => {
                  setOpenWhySuggestionId((currentId) =>
                    currentId === suggestion.id ? null : suggestion.id,
                  );
                }}
                pinned={isPinned(suggestion.id)}
                suggestion={suggestion}
                whyExpanded={openWhySuggestionId === suggestion.id}
              />
            ))}
          </article>
          ))
          : null}

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
            </div>
          </div>
        ) : null}

        {!hasActiveStreamingBatch && hasVisibleBatches
          ? visibleBatches.map((batch, batchIndex) => (
          <article key={batch.id}>
            {batchIndex > 0 ? (
              <div className="batch-divider">
                <span>
                  Batch {batch.displayIndex} · {format(batch.timestamp, "HH:mm:ss")}
                </span>
              </div>
            ) : null}

            {batch.filteredSuggestions.map((suggestion, suggestionIndex) => (
              <SuggestionCard
                key={suggestion.id}
                animationIndex={batchIndex * 3 + suggestionIndex}
                expanded={expandedSuggestionId === suggestion.id}
                onContextMenu={(event, selectedSuggestion) => {
                  event.preventDefault();
                  openContextMenu(selectedSuggestion, event.clientX, event.clientY, batch.meta);
                }}
                evidenceTimestamp={resolveTimestampForSuggestion?.(suggestion) ?? null}
                onCopy={() => onCopySuggestion?.(suggestion)}
                onDismiss={() => {
                  handleDismiss(suggestion);
                  if (openWhySuggestionId === suggestion.id) {
                    setOpenWhySuggestionId(null);
                  }
                }}
                onJumpToTimestamp={onJumpToTimestamp}
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
                onTogglePin={() => togglePin(suggestion.id, suggestion)}
                onToggleWhy={() => {
                  setOpenWhySuggestionId((currentId) =>
                    currentId === suggestion.id ? null : suggestion.id,
                  );
                }}
                pinned={isPinned(suggestion.id)}
                suggestion={suggestion}
                whyExpanded={openWhySuggestionId === suggestion.id}
              />
            ))}

            {batch.isMutedPlaceholder ? (
              <div className="suggestion-batch-placeholder">— muted by filters —</div>
            ) : null}
          </article>
            ))
          : null}

        {!shouldShowWrapUp && shouldShowSkip && ambientQuote ? <SkipCard quote={ambientQuote} /> : null}

        {!hasRenderableContent ? (
          <div className="text-[12px] leading-[1.6] text-[var(--text-dim)]">
            Suggestions appear here every 30 seconds while the conversation is active.
          </div>
        ) : null}
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
