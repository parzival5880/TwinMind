"use client";

import { format } from "date-fns";
import type { GroundingDebugState, PipelineDebugState } from "@/hooks/useSuggestions";

type Props = {
  debug: PipelineDebugState | null;
  grounding: GroundingDebugState | null;
};

const formatMs = (value?: number) =>
  typeof value === "number" ? `${Math.round(value)}ms` : "—";

export function SuggestionPipelineDebugPanel({ debug, grounding }: Props) {
  return (
    <aside className="soft-panel mt-4 rounded-[2rem] p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Debug · Suggestion pipeline
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Last batch · 6 candidates → 3 picks
          </h2>
        </div>
        {debug ? (
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
            Batch {debug.batchId.slice(0, 16)} · {format(new Date(debug.recordedAt), "HH:mm:ss")}
          </p>
        ) : (
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
            Waiting for first pipeline batch…
          </p>
        )}
      </div>

      {debug ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCell label="Call A" value={formatMs(debug.pipeline.call_a_ms)} />
            <StatCell label="Call B" value={formatMs(debug.pipeline.call_b_ms)} />
            <StatCell label="Candidates" value={String(debug.pipeline.candidates.length)} />
            <StatCell
              label="Critique"
              value={debug.pipeline.critique_skipped_budget ? "skipped" : "used"}
            />
            <StatCell
              label="Retry"
              value={debug.pipeline.retry_fired ? "fired" : "no"}
            />
          </div>

          {grounding ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCell label="Grounded facts" value={String(grounding.grounding.facts_count)} />
              <StatCell label="Entities" value={String(grounding.grounding.entities_found)} />
              <StatCell label="Searches used" value={String(grounding.grounding.searches_used)} />
              <StatCell label="Cache hits" value={String(grounding.grounding.cache_hits)} />
              <StatCell
                label="Grounding"
                value={grounding.grounding.skipped_reason ?? "active"}
              />
            </div>
          ) : null}

          {debug.pipeline.fell_back_to_raw ? (
            <p className="mt-3 rounded-[0.75rem] border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
              Fallback path active — emitted raw candidates.
            </p>
          ) : null}

          <div className="mt-6 grid gap-5 xl:grid-cols-2">
            <section>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                6 candidates (call A)
              </p>
              <ol className="mt-2 space-y-2">
                {debug.pipeline.candidates.map((candidate, index) => (
                  <li
                    key={`candidate-${index}`}
                    className="rounded-[1rem] border border-slate-200 bg-white/85 p-3 text-sm text-slate-700"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        {candidate.type}
                      </span>
                      <span className="text-[10.5px] font-mono text-slate-400">
                        #{index + 1}
                      </span>
                    </div>
                    <p className="mt-1 text-[10.5px] uppercase tracking-[0.12em] text-slate-400">
                      conviction: {candidate.conviction ?? "high"}
                    </p>
                    <p className="mt-1 text-[12.5px] font-medium text-slate-900">
                      {candidate.preview}
                    </p>
                    <p className="mt-1 text-[11.5px] italic text-slate-500">
                      rationale: {candidate.rationale}
                    </p>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                3 picks (call B)
              </p>
              <ol className="mt-2 space-y-2">
                {debug.pipeline.selections.map((selection, index) => (
                  <li
                    key={`selection-${selection.id}-${index}`}
                    className="rounded-[1rem] border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        {selection.type}
                      </span>
                      <span className="text-[10.5px] font-mono text-slate-400">
                        pick {index + 1}
                      </span>
                    </div>
                    <p className="mt-1 text-[10.5px] uppercase tracking-[0.12em] text-slate-400">
                      conviction: {selection.conviction ?? "high"}
                    </p>
                    <p className="mt-1 text-[12.5px] font-medium text-slate-900">
                      {selection.preview}
                    </p>
                    {selection.selection_reason ? (
                      <p className="mt-1 text-[11.5px] italic text-slate-600">
                        why: {selection.selection_reason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </>
      ) : (
        <p className="mt-4 rounded-[1rem] border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-500">
          Generate a batch while the app is open with <code>?debug=1</code> to populate
          this panel.
        </p>
      )}
    </aside>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-[1.25rem] border border-slate-200 bg-white/80 p-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
    </article>
  );
}
