"use client";

import { useAudio } from "@/hooks/useAudio";

type AudioRecorderProps = {
  error?: string | null;
  isRecording?: boolean;
  onAudioChunk?: (blob: Blob, timestamp: Date) => void;
  onStartRecording?: () => Promise<void> | void;
  onStopRecording?: () => void;
  recordingDurationMs?: number;
  transcriptionNotice?: string | null;
};

const formatRecordingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
};

export function AudioRecorder({
  error,
  isRecording,
  onAudioChunk,
  onStartRecording,
  onStopRecording,
  recordingDurationMs,
  transcriptionNotice,
}: AudioRecorderProps) {
  const internalAudio = useAudio({ onAudioChunk });
  const isControlled =
    typeof isRecording === "boolean" ||
    typeof onStartRecording === "function" ||
    typeof onStopRecording === "function" ||
    typeof recordingDurationMs === "number" ||
    typeof error === "string";

  const resolvedIsRecording = isControlled ? Boolean(isRecording) : internalAudio.isRecording;
  const resolvedError = isControlled ? error ?? null : internalAudio.error;
  const resolvedDurationMs = isControlled
    ? recordingDurationMs ?? 0
    : internalAudio.recordingDurationMs;
  const resolvedTranscriptionNotice = isControlled
    ? transcriptionNotice ?? null
    : internalAudio.transcriptionNotice;
  const handleToggleRecording = async () => {
    if (resolvedIsRecording) {
      if (isControlled) {
        onStopRecording?.();
      } else {
        internalAudio.stopRecording();
      }

      return;
    }

    if (isControlled) {
      await onStartRecording?.();
    } else {
      await internalAudio.startRecording();
    }
  };

  return (
    <section
      aria-label="Audio recorder"
      className="soft-panel rounded-[2rem] p-6"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
              Audio Capture
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
              Record your microphone in 8-second chunks.
            </h2>
            <p className="max-w-xl text-sm leading-6 text-slate-600">
              The recorder requests microphone access, emits audio blobs on a fixed interval, and
              safely handles permission or compatibility failures.
            </p>
          </div>

          <div
            aria-live="polite"
            className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={`inline-flex h-3.5 w-3.5 rounded-full ${
                  resolvedIsRecording ? "animate-pulse bg-rose-500 shadow-[0_0_0_8px_rgba(244,63,94,0.16)]" : "bg-slate-300"
                }`}
              />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Status
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {resolvedIsRecording
                    ? `Recording... ${formatRecordingDuration(resolvedDurationMs)}`
                    : "Not Recording"}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            aria-pressed={resolvedIsRecording}
            className={`inline-flex min-h-14 items-center justify-center rounded-full px-6 py-3.5 text-base font-semibold shadow-sm ${
              resolvedIsRecording
                ? "bg-rose-500 text-white hover:-translate-y-0.5 hover:bg-rose-400"
                : "bg-teal-700 text-white hover:-translate-y-0.5 hover:bg-teal-600"
            }`}
            type="button"
            onClick={() => {
              void handleToggleRecording();
            }}
          >
            <span
              aria-hidden="true"
              className={`mr-3 inline-flex h-4 w-4 rounded-full ${
                resolvedIsRecording ? "bg-white shadow-[0_0_0_6px_rgba(255,255,255,0.2)]" : "bg-teal-200"
              }`}
            />
            {resolvedIsRecording ? "Stop Recording" : "Start Recording"}
          </button>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
            Default chunk interval: 8 seconds
          </p>
        </div>

        {resolvedError ? (
          <p
            aria-live="assertive"
            className="rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
            role="alert"
          >
            {resolvedError}
          </p>
        ) : null}

        {resolvedTranscriptionNotice ? (
          <div
            aria-live="polite"
            className="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            role="status"
          >
            {resolvedTranscriptionNotice}
          </div>
        ) : null}
      </div>
    </section>
  );
}
