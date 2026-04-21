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

export function AudioRecorder({
  error,
  isRecording,
  isSpeaking,
  isTranscribing,
  onAudioChunk,
  onStartRecording,
  onStopRecording,
  transcriptionNotice,
}: AudioRecorderProps) {
  const internalAudio = useAudio({ onAudioChunk });
  const isControlled =
    typeof isRecording === "boolean" ||
    typeof onStartRecording === "function" ||
    typeof onStopRecording === "function" ||
    typeof error === "string";

  const resolvedIsRecording = isControlled ? Boolean(isRecording) : internalAudio.isRecording;
  const resolvedIsSpeaking = isControlled ? Boolean(isSpeaking) : internalAudio.isSpeaking;
  const resolvedError = isControlled ? error ?? null : internalAudio.error;
  const resolvedIsTranscribing = isControlled ? Boolean(isTranscribing) : internalAudio.isTranscribing;
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

  const statusText = resolvedIsTranscribing
    ? "Transcribing…"
    : resolvedIsRecording
      ? resolvedIsSpeaking
        ? "Recording…"
        : "Listening · waiting for speech"
      : "Click to start recording";

  return (
    <section aria-label="Audio recorder" className="mic-area">
      <div className="mic-wrap" data-live={resolvedIsRecording}>
        <div className="mic-ring" />
        <div className="mic-ring" />
        <div className="mic-ring" />
        <button
          aria-label={resolvedIsRecording ? "Stop recording" : "Start recording"}
          aria-pressed={resolvedIsRecording}
          className="mic-btn"
          data-live={resolvedIsRecording}
          type="button"
          onClick={() => {
            void handleToggleRecording();
          }}
        >
          <svg
            aria-hidden="true"
            className="h-[22px] w-[22px]"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="23" />
            <line x1="8" x2="16" y1="23" y2="23" />
          </svg>
        </button>
      </div>

      <span className="mic-state">{statusText}</span>

      <div className={`waveform ${resolvedIsRecording ? "live" : ""}`}>
        {Array.from({ length: 7 }, (_, index) => (
          <div key={`wave-${index}`} className="wave-bar" />
        ))}
      </div>

      {resolvedError ? (
        <div aria-live="assertive" className="mic-inline-alert" role="alert">
          <p>{resolvedError}</p>
          {resolvedError.toLowerCase().includes("grant mic access") ? (
            <button
              className="mt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--rose)] hover:text-[#fecaca]"
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
        <div aria-live="polite" className="mic-inline-note" role="status">
          {resolvedTranscriptionNotice}
        </div>
      ) : null}
    </section>
  );
}
