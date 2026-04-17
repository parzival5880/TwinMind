"use client";

import { memo, useEffect, useMemo, useRef, type ReactElement } from "react";
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
  jumpTarget?: TranscriptJumpTarget | null;
  onClear: () => void;
};

const VIRTUALIZATION_THRESHOLD = 200;
const DEFAULT_ROW_HEIGHT = 112;

const estimateRowHeight = (chunk: TranscriptChunk) =>
  Math.max(DEFAULT_ROW_HEIGHT, 72 + Math.ceil(chunk.text.length / 72) * 28);

const TranscriptChunkCard = memo(function TranscriptChunkCard({
  chunk,
  highlighted,
  registerElement,
}: {
  chunk: TranscriptChunk;
  highlighted?: boolean;
  registerElement?: (element: HTMLElement | null) => void;
}) {
  return (
    <article
      ref={registerElement}
      className={`rounded-[1.25rem] border bg-white/95 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)] transition ${
        highlighted ? "border-teal-400 shadow-[0_18px_50px_rgba(13,148,136,0.18)]" : "border-slate-200"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-4">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-slate-400">
          {format(chunk.timestamp, "HH:mm:ss")}
        </p>
        {chunk.speaker ? (
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            {chunk.speaker}
          </p>
        ) : null}
      </div>
      <p className="font-mono text-sm leading-7 text-slate-800">{chunk.text}</p>
    </article>
  );
});

type VirtualRowProps = {
  chunks: TranscriptChunk[];
  highlightedChunkId?: string;
};

function VirtualTranscriptRow({
  ariaAttributes,
  chunks,
  highlightedChunkId,
  index,
  style,
}: RowComponentProps<VirtualRowProps>): ReactElement {
  const chunk = chunks[index];

  return (
    <div {...ariaAttributes} style={style}>
      <div className="px-1 py-1.5">
        <TranscriptChunkCard chunk={chunk} highlighted={chunk.id === highlightedChunkId} />
      </div>
    </div>
  );
}

export function TranscriptPanel({
  chunks,
  error,
  isRecording = false,
  jumpTarget,
  onClear,
}: TranscriptPanelProps) {
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const chunkElementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const listRef = useRef<ListImperativeAPI | null>(null);
  const highlightedChunkId = useMemo(() => {
    if (!jumpTarget) {
      return null;
    }

    return (
      chunks.find((chunk) => format(chunk.timestamp, "HH:mm") === jumpTarget.timestamp)?.id ?? null
    );
  }, [chunks, jumpTarget]);
  const shouldVirtualize = chunks.length > VIRTUALIZATION_THRESHOLD;
  const statusLabel = error
    ? "Error"
    : chunks.length === 0
      ? isRecording
        ? "Listening"
        : "Idle"
      : "Success";
  const statusClassName = error
    ? "bg-rose-100 text-rose-700"
    : chunks.length === 0
      ? "bg-slate-200 text-slate-700"
      : "bg-emerald-100 text-emerald-700";

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
  }, [chunks.length, listRef, shouldVirtualize]);

  useEffect(() => {
    if (!jumpTarget) {
      return;
    }

    const matchingChunkIndex = chunks.findIndex(
      (chunk) => format(chunk.timestamp, "HH:mm") === jumpTarget.timestamp,
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
  }, [chunks, jumpTarget, listRef, shouldVirtualize]);

  return (
    <section
      aria-label="Transcript panel"
      className="soft-panel flex min-h-0 flex-col rounded-[2rem] p-6"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Transcript
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            Continuous transcript feed
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {error
              ? "Transcript capture hit a problem. Retry the mic to continue."
              : chunks.length === 0
                ? "Audio chunks appear here as soon as recording starts."
                : "Latest transcript chunks append in timestamp order and auto-scroll to the newest context."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold shadow-sm ${statusClassName}`}>
            {statusLabel}
          </span>
          <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white shadow-sm">
            {chunks.length} chunks
          </span>
          <button
            className="rounded-full border border-slate-300 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-slate-950 hover:text-slate-950"
            type="button"
            onClick={onClear}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="panel-scroll transcript-scroll flex-1 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-50/90 p-4">
        {chunks.length === 0 ? (
          <article className="rounded-[1.25rem] border border-dashed border-slate-300 bg-white/90 p-4">
            <p className="font-mono text-sm leading-6 text-slate-500">
              Click the mic to start. Your transcript will appear here in real-time.
            </p>
          </article>
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
              chunks,
              highlightedChunkId: highlightedChunkId ?? undefined,
            }}
            style={{ height: "100%" }}
          />
        ) : (
          <div className="h-full space-y-3 overflow-y-auto pr-1">
            {chunks.map((chunk) => (
              <TranscriptChunkCard
                key={chunk.id}
                chunk={chunk}
                highlighted={chunk.id === highlightedChunkId}
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
          </div>
        )}
      </div>
    </section>
  );
}
