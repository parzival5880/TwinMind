"use client";

import { useAudio } from "@/hooks/useAudio";

type AudioRecorderProps = {
  error?: string | null;
  isRecording?: boolean;
  isSpeaking?: boolean;
  isTranscribing?: boolean;
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
  isSpeaking,
  isTranscribing,
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
  const resolvedIsSpeaking = isControlled ? Boolean(isSpeaking) : internalAudio.isSpeaking;
  const resolvedError = isControlled ? error ?? null : internalAudio.error;
  const resolvedIsTranscribing = isControlled ? Boolean(isTranscribing) : internalAudio.isTranscribing;
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
              Record with overlapping, VAD-aware windows.
            </h2>
            <p className="max-w-xl text-sm leading-6 text-slate-600">
              Start the mic to stream audio into overlapping windows, skip long silence, and keep transcript updates arriving in order.
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
                  resolvedIsRecording && resolvedIsSpeaking
                    ? "animate-pulse bg-rose-500 shadow-[0_0_0_8px_rgba(244,63,94,0.16)]"
                    : resolvedIsRecording
                      ? "bg-slate-400 shadow-[0_0_0_8px_rgba(148,163,184,0.12)]"
                      : "bg-slate-300"
                }`}
              />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Status
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {resolvedIsRecording
                    ? resolvedIsSpeaking
                      ? `Recording... ${formatRecordingDuration(resolvedDurationMs)}`
                      : `Listening... ${formatRecordingDuration(resolvedDurationMs)}`
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
            15-second windows every 12 seconds with VAD-aware overlap
          </p>
        </div>

        {resolvedIsTranscribing ? (
          <div
            aria-live="polite"
            className="rounded-[1.25rem] border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800"
            role="status"
          >
            <div className="flex items-center justify-between gap-4">
              <p className="font-medium">Transcribing...</p>
              <span className="text-xs uppercase tracking-[0.16em] text-teal-700">Loading</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-teal-100">
              <div className="skeleton-shimmer h-full w-1/2 rounded-full bg-teal-300/70" />
            </div>
          </div>
        ) : null}

        {resolvedError ? (
          <div
            aria-live="assertive"
            className="rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
            role="alert"
          >
            <p>{resolvedError}</p>
            {resolvedError.toLowerCase().includes("grant mic access") ? (
              <button
                className="mt-3 rounded-full border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:border-rose-500 hover:text-rose-800"
                type="button"
                onClick={() => {
                  void handleToggleRecording();
                }}
              >
                Grant mic access
              </button>
            ) : null}
          </div>
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
