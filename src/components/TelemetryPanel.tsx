"use client";

import { format } from "date-fns";
import {
  summarizeTelemetryMeasurements,
  useTelemetryMeasurements,
  type TelemetryMetricName,
} from "@/lib/telemetry";

const metricLabels: Record<TelemetryMetricName, string> = {
  transcription_round_trip: "Audio chunk → transcript",
  suggestions_first_render: "Refresh → first suggestion",
  chat_first_token: "Chat send → first token",
  chat_last_token: "Chat send → last token",
};

export function TelemetryPanel() {
  const measurements = useTelemetryMeasurements();
  const summaries = summarizeTelemetryMeasurements(measurements);

  return (
    <aside className="soft-panel mt-4 rounded-[2rem] p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Debug Telemetry
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Last 10 browser measurements
          </h2>
        </div>
        <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
          Enable with <code>?debug=1</code>
        </p>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-4">
        {summaries.map((summary) => (
          <article
            key={summary.metric}
            className="rounded-[1.25rem] border border-slate-200 bg-white/80 p-4"
          >
            <p className="text-sm font-semibold text-slate-900">{metricLabels[summary.metric]}</p>
            <div className="mt-3 flex items-end justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  p50
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-950">
                  {summary.p50 === null ? "—" : `${summary.p50}ms`}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  p95
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-950">
                  {summary.p95 === null ? "—" : `${summary.p95}ms`}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Count
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-950">{summary.count}</p>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-y-2 text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-[0.16em] text-slate-400">
              <th className="px-3">Metric</th>
              <th className="px-3">Duration</th>
              <th className="px-3">Recorded</th>
              <th className="px-3">Meta</th>
            </tr>
          </thead>
          <tbody>
            {measurements.length === 0 ? (
              <tr>
                <td className="rounded-[1rem] border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-slate-500" colSpan={4}>
                  No telemetry yet. Use the app with <code>?debug=1</code> to capture timings.
                </td>
              </tr>
            ) : null}

            {measurements.map((measurement) => (
              <tr key={measurement.id} className="rounded-[1rem] bg-white/85 text-slate-700">
                <td className="rounded-l-[1rem] px-3 py-3 font-medium text-slate-900">
                  {metricLabels[measurement.metric]}
                </td>
                <td className="px-3 py-3">{measurement.durationMs}ms</td>
                <td className="px-3 py-3">
                  {format(new Date(measurement.recordedAt), "HH:mm:ss")}
                </td>
                <td className="rounded-r-[1rem] px-3 py-3 text-xs text-slate-500">
                  {measurement.meta
                    ? Object.entries(measurement.meta)
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(" · ")
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
