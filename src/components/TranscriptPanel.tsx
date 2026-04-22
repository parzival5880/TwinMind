"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { format } from "date-fns";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";
import type { TranscriptChunk } from "@/lib/types";

type TranscriptJumpTarget = {
  requestId: number;
  timestamp: string;
};

type TranscriptPanelProps = {
  chunks: TranscriptChunk[];
  error?: string | null;
  isRecording?: boolean;
  isSpeaking?: boolean;
  isTranscribing?: boolean;
  jumpTarget?: TranscriptJumpTarget | null;
};

const VIRTUALIZATION_THRESHOLD = 200;
const DEFAULT_ROW_HEIGHT = 64;

const estimateRowHeight = (chunk: TranscriptChunk) =>
  Math.max(DEFAULT_ROW_HEIGHT, 32 + Math.ceil(chunk.text.length / 78) * 22);

const matchesJumpTimestamp = (chunk: TranscriptChunk, timestamp: string) => {
  const normalizedTimestamp = timestamp.trim();

  return (
    format(chunk.timestamp, "HH:mm:ss") === normalizedTimestamp ||
    format(chunk.timestamp, "HH:mm") === normalizedTimestamp
  );
};

const shouldAccentChunk = (chunk: TranscriptChunk, previousChunk?: TranscriptChunk) => {
  if (!previousChunk) {
    return true;
  }

  if (chunk.speaker && previousChunk.speaker && chunk.speaker !== previousChunk.speaker) {
    return true;
  }

  return false;
};

const TranscriptChunkRow = memo(function TranscriptChunkRow({
  chunk,
  highlighted,
  isActive,
  shouldAccent,
  registerElement,
}: {
  chunk: TranscriptChunk;
  highlighted?: boolean;
  isActive?: boolean;
  shouldAccent?: boolean;
  registerElement?: (element: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={registerElement}
      className={`ts-chunk${highlighted ? " highlighted" : ""}`}
    >
      <div className="ts-timestamp">{format(chunk.timestamp, "HH:mm:ss")}</div>
      <div className="ts-text">
        {shouldAccent ? <strong>{chunk.text}</strong> : chunk.text}
        {isActive ? <span className="typewriter-cursor" /> : null}
      </div>
    </div>
  );
});

type VirtualRowProps = {
  activeChunkId?: string;
  chunks: TranscriptChunk[];
  highlightedChunkId?: string;
};

function VirtualTranscriptRow({
  ariaAttributes,
  chunks,
  highlightedChunkId,
  index,
  style,
  activeChunkId,
}: RowComponentProps<VirtualRowProps>): ReactElement {
  const chunk = chunks[index];

  return (
    <div {...ariaAttributes} style={style}>
      <TranscriptChunkRow
        chunk={chunk}
        highlighted={chunk.id === highlightedChunkId}
        isActive={chunk.id === activeChunkId}
        shouldAccent={shouldAccentChunk(chunk, chunks[index - 1])}
      />
    </div>
  );
}

export function TranscriptPanel({
  chunks,
  error,
  isSpeaking = false,
  isTranscribing = false,
  jumpTarget,
}: TranscriptPanelProps) {
  const [flashHighlightedChunkId, setFlashHighlightedChunkId] = useState<string | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const chunkElementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const listRef = useRef<ListImperativeAPI | null>(null);
  const matchingJumpChunkId = useMemo(() => {
    if (!jumpTarget) {
      return null;
    }

    return chunks.find((chunk) => matchesJumpTimestamp(chunk, jumpTarget.timestamp))?.id ?? null;
  }, [chunks, jumpTarget]);
  const shouldVirtualize = chunks.length > VIRTUALIZATION_THRESHOLD;
  const activeChunkId =
    (isSpeaking || isTranscribing) && chunks.length > 0 ? chunks[chunks.length - 1]?.id : undefined;

  useEffect(() => {
    if (chunks.length === 0) {
      return;
    }

    if (shouldVirtualize) {
      listRef.current?.scrollToRow({
        align: "end",
        behavior: "smooth",
        index: chunks.length - 1,
      });

      return;
    }

    scrollAnchorRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [chunks.length, shouldVirtualize]);

  useEffect(() => {
    if (!jumpTarget) {
      return;
    }

    const matchingChunkIndex = chunks.findIndex((chunk) =>
      matchesJumpTimestamp(chunk, jumpTarget.timestamp),
    );

    if (matchingChunkIndex === -1) {
      return;
    }

    if (shouldVirtualize) {
      listRef.current?.scrollToRow({
        align: "center",
        behavior: "smooth",
        index: matchingChunkIndex,
      });

      return;
    }

    const matchingChunk = chunks[matchingChunkIndex];

    chunkElementMapRef.current.get(matchingChunk.id)?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [chunks, jumpTarget, shouldVirtualize]);

  useEffect(() => {
    if (!jumpTarget || !matchingJumpChunkId) {
      return;
    }

    const startHighlightTimeoutId = window.setTimeout(() => {
      setFlashHighlightedChunkId(matchingJumpChunkId);
    }, 0);
    const timeoutId = window.setTimeout(() => {
      setFlashHighlightedChunkId((currentValue) =>
        currentValue === matchingJumpChunkId ? null : currentValue,
      );
    }, 1_000);

    return () => {
      window.clearTimeout(startHighlightTimeoutId);
      window.clearTimeout(timeoutId);
    };
  }, [jumpTarget, matchingJumpChunkId]);

  return (
    <section aria-label="Transcript panel" className="flex min-h-0 flex-1 flex-col">
      {error ? (
        <div className="mx-4 mb-3 rounded-[var(--radius)] border border-[rgba(248,113,113,.22)] bg-[rgba(248,113,113,.08)] px-3 py-2 text-[11px] leading-[1.55] text-[var(--rose)]">
          {error}
        </div>
      ) : null}

      <div className="transcript-scroll col-scroll flex-1 overflow-y-auto px-4 pb-4">
        <div className="transcript-stream">
          {chunks.length === 0 ? (
            <div className="ts-chunk">
              <div className="ts-timestamp">00:00:00</div>
              <div className="ts-text">Click to start recording.</div>
            </div>
          ) : null}

          {shouldVirtualize ? (
            <List
              className="h-full"
              defaultHeight={560}
              listRef={listRef}
              overscanCount={6}
              rowComponent={VirtualTranscriptRow}
              rowCount={chunks.length}
              rowHeight={(index) => estimateRowHeight(chunks[index])}
              rowProps={{
                activeChunkId,
                chunks,
                highlightedChunkId: flashHighlightedChunkId ?? undefined,
              }}
              style={{ height: "100%" }}
            />
          ) : (
            <>
              {chunks.map((chunk, index) => (
                <TranscriptChunkRow
                  key={chunk.id}
                  chunk={chunk}
                  highlighted={chunk.id === flashHighlightedChunkId}
                  isActive={chunk.id === activeChunkId}
                  shouldAccent={shouldAccentChunk(chunk, chunks[index - 1])}
                  registerElement={(element) => {
                    if (element) {
                      chunkElementMapRef.current.set(chunk.id, element);
                    } else {
                      chunkElementMapRef.current.delete(chunk.id);
                    }
                  }}
                />
              ))}
              <div ref={scrollAnchorRef} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
