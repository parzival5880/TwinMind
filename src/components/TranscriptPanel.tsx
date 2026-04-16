"use client";

import { useEffect, useRef } from "react";
import { format } from "date-fns";
import type { TranscriptChunk } from "@/lib/types";

type TranscriptPanelProps = {
  chunks: TranscriptChunk[];
  onClear: () => void;
};

export function TranscriptPanel({ chunks, onClear }: TranscriptPanelProps) {
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [chunks.length]);

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
        </div>
        <div className="flex items-center gap-3">
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

      <div className="panel-scroll transcript-scroll flex-1 overflow-y-auto rounded-[1.5rem] border border-slate-200 bg-slate-50/90 p-4">
        <div className="space-y-3">
          {chunks.length === 0 ? (
            <article className="rounded-[1.25rem] border border-dashed border-slate-300 bg-white/90 p-4">
              <p className="font-mono text-sm leading-6 text-slate-500">
                Start recording to capture audio chunks and build the transcript stream.
              </p>
            </article>
          ) : null}

          {chunks.map((chunk) => (
            <article
              key={chunk.id}
              className="rounded-[1.25rem] border border-slate-200 bg-white/95 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
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
          ))}
          <div ref={scrollAnchorRef} />
        </div>
      </div>
    </section>
  );
}
