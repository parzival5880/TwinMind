"use client";

import { useSyncExternalStore } from "react";

export type TelemetryMetricName =
  | "transcription_round_trip"
  | "suggestions_first_render"
  | "chat_first_token"
  | "chat_last_token"
  | "suggestions_skip_shown"
  | "meeting_wrap_up_generated";

export type TelemetryMeasurement = {
  durationMs: number;
  id: string;
  meta?: Record<string, string | number | boolean>;
  metric: TelemetryMetricName;
  recordedAt: string;
};

export type TelemetrySummary = {
  count: number;
  metric: TelemetryMetricName;
  p50: number | null;
  p95: number | null;
};

const MAX_MEASUREMENTS = 10;

let measurements: TelemetryMeasurement[] = [];
const subscribers = new Set<() => void>();

const notifySubscribers = () => {
  subscribers.forEach((subscriber) => {
    subscriber();
  });
};

const roundDuration = (value: number) => Math.round(value * 10) / 10;

const percentile = (values: number[], percentileValue: number) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );

  return roundDuration(sorted[index]);
};

export const recordTelemetryMeasurement = (
  metric: TelemetryMetricName,
  durationMs: number,
  meta?: Record<string, string | number | boolean>,
) => {
  if (typeof window === "undefined" || !Number.isFinite(durationMs)) {
    return;
  }

  measurements = [
    {
      durationMs: roundDuration(Math.max(0, durationMs)),
      id: `${metric}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      meta,
      metric,
      recordedAt: new Date().toISOString(),
    },
    ...measurements,
  ].slice(0, MAX_MEASUREMENTS);

  notifySubscribers();
};

export const recordTelemetryEvent = (
  metric: TelemetryMetricName,
  meta?: Record<string, string | number | boolean>,
) => {
  recordTelemetryMeasurement(metric, 0, meta);
};

export const startTelemetryMeasurement = (
  metric: TelemetryMetricName,
  meta?: Record<string, string | number | boolean>,
) => {
  const startedAt =
    typeof window !== "undefined" && typeof window.performance !== "undefined"
      ? window.performance.now()
      : Date.now();
  let completed = false;

  return (extraMeta?: Record<string, string | number | boolean>) => {
    if (completed) {
      return;
    }

    completed = true;

    const endedAt =
      typeof window !== "undefined" && typeof window.performance !== "undefined"
        ? window.performance.now()
        : Date.now();

    recordTelemetryMeasurement(metric, endedAt - startedAt, {
      ...meta,
      ...extraMeta,
    });
  };
};

const subscribe = (callback: () => void) => {
  subscribers.add(callback);

  return () => {
    subscribers.delete(callback);
  };
};

const getSnapshot = () => measurements;

export const useTelemetryMeasurements = () =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const summarizeTelemetryMeasurements = (
  entries: TelemetryMeasurement[],
): TelemetrySummary[] => {
  const metrics: TelemetryMetricName[] = [
    "transcription_round_trip",
    "suggestions_first_render",
    "chat_first_token",
    "chat_last_token",
    "suggestions_skip_shown",
    "meeting_wrap_up_generated",
  ];

  return metrics.map((metric) => {
    const durations = entries
      .filter((entry) => entry.metric === metric)
      .map((entry) => entry.durationMs);

    return {
      count: durations.length,
      metric,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    };
  });
};
