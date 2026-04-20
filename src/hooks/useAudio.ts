"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { useTranscript } from "@/hooks/useTranscript";
import { startTelemetryMeasurement } from "@/lib/telemetry";
import { dedupeOverlap } from "@/lib/transcript-dedupe";
import {
  DEFAULT_VAD_THRESHOLD,
  computeRms,
  getSpeechRatio,
  pruneVadFrames,
} from "@/lib/vad";
import type { TranscriptChunk, TranscribeResponse } from "@/lib/types";

type UseAudioOptions = {
  chunkDurationMs?: number;
  groqApiKey?: string;
  onAudioChunk?: (blob: Blob, timestamp: Date) => void;
  onTranscript?: (chunk: TranscriptChunk) => void;
  vadThreshold?: number;
};

type UseAudioResult = {
  clearTranscript: () => void;
  committedTranscript: TranscriptChunk[];
  error: string | null;
  flushPendingChunk: () => Promise<void>;
  isRecording: boolean;
  isSpeaking: boolean;
  isTranscribing: boolean;
  recordingDurationMs: number;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  transcriptionNotice: string | null;
  transcript: TranscriptChunk[];
};

type BrowserAudioContextConstructor = new () => AudioContext;
type BrowserWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: BrowserAudioContextConstructor;
  };

type AudioSlice = {
  blob: Blob;
  endTimestampMs: number;
  startTimestampMs: number;
};

type PendingTranscriptionWindow = {
  attempt: number;
  audioBlob: Blob;
  endTimestampMs: number;
  generation: number;
  previousTail: string;
  startTimestampMs: number;
  timestamp: Date;
  windowId: string;
};

type CompletedTranscriptionWindow = {
  id: string;
  rawText: string;
  timestamp: Date;
  startMs?: number;
  endMs?: number;
};

const MEDIA_RECORDER_TIMESLICE_MS = 5_000;
const MAX_PARALLEL_TRANSCRIPTIONS = 2;
const MAX_PENDING_TRANSCRIPTION_NOTICE = 3;
const MAX_TRANSCRIPT_TAIL_CHARS = 240;
const MIN_SPEECH_RATIO = 0.2;
const VAD_FRAME_INTERVAL_MS = 100;
const VAD_WINDOW_MS = 15_000;
const TRANSCRIBE_FETCH_TIMEOUT_MS = 15_000;
const PENDING_TAIL_FLUSH_AFTER_MS = 10_000;
const PENDING_TAIL_WORD_SAFETY_LIMIT = 40;
const PENDING_TAIL_WORD_COMMIT_COUNT = 20;
const ERROR_BROWSER_UNSUPPORTED =
  "This browser does not support microphone recording with MediaRecorder.";
const ERROR_MIC_PERMISSION_DENIED =
  "Mic access denied. Grant mic access to resume recording.";
const ERROR_MIC_PERMISSION_REVOKED =
  "Mic access was revoked. Grant mic access to resume recording.";
const ERROR_MIC_NOT_FOUND = "No microphone was detected on this device.";
const ERROR_RECORDER_INTERRUPTED =
  "Microphone capture was interrupted. Attempting to resume automatically...";
const TRANSCRIPTION_RETRY_NOTICE = "Failed to transcribe audio, retrying...";
const TRANSCRIPTION_FAILURE_NOTICE = "Unable to transcribe. Check API key.";
const TRANSCRIPTION_LAG_NOTICE = "Transcription lagging";

const WHISPER_HALLUCINATIONS = new Set([
  "thank you.",
  "thank you",
  "thanks for watching.",
  "thanks for watching",
  "you",
  "the end.",
  "the end",
  "bye.",
  "bye",
  "thanks.",
  "thanks",
  "thank you for watching.",
  "thank you for watching",
  "subtitles by the amara.org community",
]);

const isWhisperHallucination = (text: string) => {
  const normalized = text.trim().toLowerCase();

  if (WHISPER_HALLUCINATIONS.has(normalized)) {
    return true;
  }

  // Single-word or punctuation-only outputs are almost always artifacts.
  if (normalized.replace(/[^a-z]/g, "").length <= 2) {
    return true;
  }

  return false;
};

const isNetworkError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error.name === "TypeError";
};

const resolveAudioContext = (): BrowserAudioContextConstructor | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const browserWindow = window as BrowserWindow;

  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext ?? null;
};

const resolveRecorderOptions = () => {
  const preferredMimeType = "audio/webm;codecs=opus";

  if (typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined") {
    if (window.MediaRecorder.isTypeSupported(preferredMimeType)) {
      return {
        audioBitsPerSecond: 32_000,
        mimeType: preferredMimeType,
      };
    }
  }

  return {
    audioBitsPerSecond: 32_000,
  };
};

const TERMINAL_PUNCTUATION_PATTERN = /[.!?…]["')\]]?\s*$/;

const joinTranscriptText = (parts: string[]) =>
  parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

const buildTranscriptText = (chunks: TranscriptChunk[]) =>
  joinTranscriptText(chunks.map((chunk) => chunk.text));

const splitTranscriptWords = (value: string) => value.trim().split(/\s+/).filter(Boolean);

const dispatchAudioDebugEvent = (eventName: string) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("twinmind:audio-debug", {
      detail: {
        event: eventName,
        timestamp: Date.now(),
      },
    }),
  );
};

export function useAudio({
  chunkDurationMs = MEDIA_RECORDER_TIMESLICE_MS,
  groqApiKey,
  onAudioChunk,
  onTranscript,
  vadThreshold = DEFAULT_VAD_THRESHOLD,
}: UseAudioOptions = {}): UseAudioResult {
  const {
    clearTranscript: baseClearTranscript,
    committedTranscript,
    replaceCommittedTranscript,
    replaceTranscript,
    transcript,
  } = useTranscript();
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [transcriptionNotice, setTranscriptionNotice] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const durationIntervalRef = useRef<number | null>(null);
  const noticeTimeoutRef = useRef<number | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const chunkCycleTimeoutRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);
  const isRestartingRecorderRef = useRef(false);
  const isChunkRolloverRef = useRef(false);
  const lastSliceTimestampRef = useRef<number | null>(null);
  const pendingWindowsRef = useRef<PendingTranscriptionWindow[]>([]);
  const recordingStartTimeRef = useRef<number | null>(null);
  const shouldKeepRecordingRef = useRef(false);
  const transcriptGenerationRef = useRef(0);
  const lastTranscriptTailRef = useRef("");
  const completedWindowsRef = useRef<CompletedTranscriptionWindow[]>([]);
  const vadFramesRef = useRef<Array<{ rms: number; timestampMs: number }>>([]);
  const inFlightCountRef = useRef(0);
  const startRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const restartRecorderSessionRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const clearDurationInterval = useCallback(() => {
    if (durationIntervalRef.current !== null) {
      window.clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimeoutRef.current !== null) {
      window.clearTimeout(noticeTimeoutRef.current);
      noticeTimeoutRef.current = null;
    }
  }, []);

  const clearChunkCycleTimer = useCallback(() => {
    if (chunkCycleTimeoutRef.current !== null) {
      window.clearTimeout(chunkCycleTimeoutRef.current);
      chunkCycleTimeoutRef.current = null;
    }
  }, []);

  const showNotice = useCallback(
    (message: string | null) => {
      clearNoticeTimer();
      setTranscriptionNotice(message);

      if (!message) {
        return;
      }

      noticeTimeoutRef.current = window.setTimeout(() => {
        setTranscriptionNotice(null);
        noticeTimeoutRef.current = null;
      }, 4_000);
    },
    [clearNoticeTimer],
  );

  const updateTranscriptionActivityState = useCallback(() => {
    const totalPending = pendingWindowsRef.current.length + inFlightCountRef.current;

    setIsTranscribing(totalPending > 0);

    if (pendingWindowsRef.current.length > MAX_PENDING_TRANSCRIPTION_NOTICE) {
      showNotice(TRANSCRIPTION_LAG_NOTICE);
    }
  }, [showNotice]);

  const stopVadLoop = useCallback(() => {
    if (vadIntervalRef.current !== null) {
      window.clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
  }, []);

  const releaseCaptureResources = useCallback(
    ({
      preserveDuration,
      preserveRecordingState,
      stopTracks,
    }: {
      preserveDuration: boolean;
      preserveRecordingState: boolean;
      stopTracks: boolean;
    }) => {
      clearDurationInterval();
      stopVadLoop();
      clearChunkCycleTimer();
      isChunkRolloverRef.current = false;

      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onerror = null;
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current = null;
      }

      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }

      if (analyserNodeRef.current) {
        analyserNodeRef.current.disconnect();
        analyserNodeRef.current = null;
      }

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => {
          if ("onended" in track) {
            track.onended = null;
          }

          if (stopTracks) {
            track.stop();
          }
        });
      }

      mediaStreamRef.current = null;

      if (audioContextRef.current) {
        void audioContextRef.current.close();
      }

      audioContextRef.current = null;
      lastSliceTimestampRef.current = null;
      vadFramesRef.current = [];
      setIsSpeaking(false);

      if (!preserveDuration) {
        recordingStartTimeRef.current = null;
        setRecordingDurationMs(0);
      }

      if (!preserveRecordingState) {
        setIsRecording(false);
      }
    },
    [clearChunkCycleTimer, clearDurationInterval, stopVadLoop],
  );

  const rebuildTranscript = useCallback(() => {
    const nextCommittedTranscript: TranscriptChunk[] = [];
    const windows = completedWindowsRef.current;
    let committedText = "";
    let pendingTail = "";
    let pendingTailStartedAtMs: number | null = null;
    let pendingTailTimestamp = windows[0]?.timestamp ?? new Date();

    for (const completedWindow of windows) {
      const incomingWindowText = completedWindow.rawText.trim();

      if (!incomingWindowText) {
        continue;
      }

      const candidateText = joinTranscriptText([pendingTail, incomingWindowText]);
      const dedupedText = dedupeOverlap(committedText.slice(-300), candidateText).trim();

      if (!dedupedText) {
        continue;
      }

      const shouldFlushPending =
        pendingTailStartedAtMs !== null &&
        completedWindow.timestamp.getTime() - pendingTailStartedAtMs >= PENDING_TAIL_FLUSH_AFTER_MS;
      const endsWithTerminalPunctuation = TERMINAL_PUNCTUATION_PATTERN.test(dedupedText);
      const dedupedWords = splitTranscriptWords(dedupedText);
      const shouldForceCommitPendingWords =
        dedupedWords.length > PENDING_TAIL_WORD_SAFETY_LIMIT;

      if (!pendingTail) {
        pendingTailTimestamp = completedWindow.timestamp;
      }

      if (shouldForceCommitPendingWords) {
        const committedPrefix = dedupedWords
          .slice(0, PENDING_TAIL_WORD_COMMIT_COUNT)
          .join(" ")
          .trim();
        const remainingPendingTail = dedupedWords
          .slice(PENDING_TAIL_WORD_COMMIT_COUNT)
          .join(" ")
          .trim();

        if (committedPrefix) {
          nextCommittedTranscript.push({
            id: `${completedWindow.id}-forced-prefix`,
            speaker: "Meeting",
            text: committedPrefix,
            timestamp: pendingTail ? pendingTailTimestamp : completedWindow.timestamp,
          });
          committedText = joinTranscriptText([committedText, committedPrefix]);
        }

        pendingTail = remainingPendingTail;
        pendingTailStartedAtMs = pendingTail ? completedWindow.timestamp.getTime() : null;
        pendingTailTimestamp = completedWindow.timestamp;
      } else if (endsWithTerminalPunctuation || shouldFlushPending) {
        const committedChunk: TranscriptChunk = {
          id: completedWindow.id,
          speaker: "Meeting",
          text: dedupedText,
          timestamp: pendingTail ? pendingTailTimestamp : completedWindow.timestamp,
        };

        nextCommittedTranscript.push(committedChunk);
        committedText = joinTranscriptText([committedText, dedupedText]);
        pendingTail = "";
        pendingTailStartedAtMs = null;
        pendingTailTimestamp = completedWindow.timestamp;
      } else {
        pendingTail = dedupedText;

        if (pendingTailStartedAtMs === null) {
          pendingTailStartedAtMs = completedWindow.timestamp.getTime();
          pendingTailTimestamp = completedWindow.timestamp;
        }
      }
    }

    const nextLiveTranscript = pendingTail
      ? [
          ...nextCommittedTranscript,
          {
            id: `pending-tail-${completedWindowsRef.current.length}`,
            speaker: "Meeting",
            text: pendingTail,
            timestamp: pendingTailTimestamp,
          },
        ]
      : nextCommittedTranscript;

    replaceCommittedTranscript(nextCommittedTranscript);
    replaceTranscript(nextLiveTranscript);
    lastTranscriptTailRef.current = buildTranscriptText(nextLiveTranscript).slice(-MAX_TRANSCRIPT_TAIL_CHARS);

    return {
      committedTranscript: nextCommittedTranscript,
      liveTranscript: nextLiveTranscript,
    };
  }, [replaceCommittedTranscript, replaceTranscript]);

  const appendCompletedWindow = useCallback(
    (completedWindow: CompletedTranscriptionWindow) => {
      const nextCompletedWindows = completedWindowsRef.current.slice();
      const insertIndex = nextCompletedWindows.findIndex(
        (currentWindow) => currentWindow.timestamp.getTime() > completedWindow.timestamp.getTime(),
      );

      if (insertIndex === -1) {
        nextCompletedWindows.push(completedWindow);
      } else {
        nextCompletedWindows.splice(insertIndex, 0, completedWindow);
      }

      completedWindowsRef.current = nextCompletedWindows;

      const rebuiltTranscript = rebuildTranscript();
      const insertedChunk = rebuiltTranscript.liveTranscript.find(
        (chunk) => chunk.id === completedWindow.id,
      );

      if (insertedChunk) {
        onTranscript?.(insertedChunk);
      }
    },
    [onTranscript, rebuildTranscript],
  );

  const processTranscriptionQueue = useCallback(async () => {
    while (
      inFlightCountRef.current < MAX_PARALLEL_TRANSCRIPTIONS &&
      pendingWindowsRef.current.length > 0
    ) {
      const nextWindow = pendingWindowsRef.current.shift();

      if (!nextWindow) {
        break;
      }

      inFlightCountRef.current += 1;
      updateTranscriptionActivityState();

      void (async () => {
        const completeTelemetry = startTelemetryMeasurement("transcription_round_trip", {
          attempt: nextWindow.attempt + 1,
          strategy: "single-slice-with-tail-prompt",
          window_ms: MEDIA_RECORDER_TIMESLICE_MS,
        });
        const abortController = new AbortController();
        const abortTimeoutId = window.setTimeout(() => {
          abortController.abort();
        }, TRANSCRIBE_FETCH_TIMEOUT_MS);

        try {
          const formData = new FormData();

          formData.append("audio", nextWindow.audioBlob, "window.webm");
          if (nextWindow.previousTail) {
            formData.append("previous_tail", nextWindow.previousTail);
          }

          const response = await fetch("/api/transcribe", {
            signal: abortController.signal,
            body: formData,
            headers: groqApiKey ? { "x-groq-api-key": groqApiKey } : undefined,
            method: "POST",
          });

          const payload = (await response.json()) as TranscribeResponse;

          if (!response.ok) {
            throw new Error(payload.error || "Transcription request failed.");
          }

          if (nextWindow.generation !== transcriptGenerationRef.current) {
            return;
          }

          const transcriptText = payload.text.trim();

          if (transcriptText && !isWhisperHallucination(transcriptText)) {
            const parsedTimestamp = new Date(payload.timestamp);

            appendCompletedWindow({
              id: nextWindow.windowId,
              rawText: transcriptText,
              timestamp:
                Number.isNaN(parsedTimestamp.getTime()) ? nextWindow.timestamp : parsedTimestamp,
              startMs: nextWindow.startTimestampMs,
              endMs: nextWindow.endTimestampMs,
            });
          }

          completeTelemetry({
            text_length: transcriptText.length,
          });
          showNotice(null);
        } catch (errorValue) {
          if (isNetworkError(errorValue) && nextWindow.attempt < 1) {
            pendingWindowsRef.current.unshift({
              ...nextWindow,
              attempt: nextWindow.attempt + 1,
            });
            showNotice(TRANSCRIPTION_RETRY_NOTICE);
          } else {
            showNotice(TRANSCRIPTION_FAILURE_NOTICE);
          }
        } finally {
          window.clearTimeout(abortTimeoutId);
          inFlightCountRef.current = Math.max(0, inFlightCountRef.current - 1);
          updateTranscriptionActivityState();

          if (pendingWindowsRef.current.length > 0) {
            void processTranscriptionQueue();
          }
        }
      })();
    }
  }, [appendCompletedWindow, groqApiKey, showNotice, updateTranscriptionActivityState]);

  const enqueueTranscriptionWindow = useCallback(
    (slice: AudioSlice) => {
      if (!slice.blob || slice.blob.size === 0) {
        return;
      }

      const windowFrames = vadFramesRef.current.filter(
        (frame) =>
          frame.timestampMs >= Math.max(slice.startTimestampMs, slice.endTimestampMs - VAD_WINDOW_MS) &&
          frame.timestampMs <= slice.endTimestampMs,
      );
      const speechRatio = getSpeechRatio(windowFrames, slice.startTimestampMs, vadThreshold);

      if (speechRatio < MIN_SPEECH_RATIO) {
        return;
      }

      const windowTimestamp = new Date(slice.startTimestampMs);

      onAudioChunk?.(slice.blob, windowTimestamp);
      pendingWindowsRef.current.push({
        attempt: 0,
        audioBlob: slice.blob,
        endTimestampMs: slice.endTimestampMs,
        generation: transcriptGenerationRef.current,
        previousTail: lastTranscriptTailRef.current,
        startTimestampMs: slice.startTimestampMs,
        timestamp: windowTimestamp,
        windowId: uuidv4(),
      });
      updateTranscriptionActivityState();
      void processTranscriptionQueue();
    },
    [onAudioChunk, processTranscriptionQueue, updateTranscriptionActivityState, vadThreshold],
  );

  const handleAudioSlice = useCallback(
    (audioBlob: Blob) => {
      // CHUNK_OVERLAP_STRATEGY: each upload comes from a fresh MediaRecorder
      // segment, not a long-running timeslice stream, so every blob is a
      // self-contained webm/opus file. Continuity comes from previous_tail plus
      // transcript-level overlap dedupe rather than re-sending prior fragments.
      const now = Date.now();
      const previousSliceTimestamp =
        lastSliceTimestampRef.current ?? now - MEDIA_RECORDER_TIMESLICE_MS;
      const currentChunk: AudioSlice = {
        blob: audioBlob,
        endTimestampMs: now,
        startTimestampMs: previousSliceTimestamp,
      };

      lastSliceTimestampRef.current = now;
      enqueueTranscriptionWindow(currentChunk);
    },
    [enqueueTranscriptionWindow],
  );

  const scheduleChunkFlush = useCallback(
    (mediaRecorder: MediaRecorder) => {
      clearChunkCycleTimer();

      chunkCycleTimeoutRef.current = window.setTimeout(() => {
        if (
          !shouldKeepRecordingRef.current ||
          isRestartingRecorderRef.current ||
          mediaRecorder.state !== "recording"
        ) {
          chunkCycleTimeoutRef.current = null;
          return;
        }

        isChunkRolloverRef.current = true;
        chunkCycleTimeoutRef.current = null;

        try {
          mediaRecorder.stop();
        } catch {
          isChunkRolloverRef.current = false;
          void restartRecorderSessionRef.current?.();
        }
      }, chunkDurationMs);
    },
    [chunkDurationMs, clearChunkCycleTimer],
  );

  const restartRecorderSession = useCallback(async () => {
    if (isRestartingRecorderRef.current || !shouldKeepRecordingRef.current) {
      return;
    }

    isRestartingRecorderRef.current = true;
    showNotice(ERROR_RECORDER_INTERRUPTED);

    const preservedStartTime = recordingStartTimeRef.current ?? Date.now();

    releaseCaptureResources({
      preserveDuration: true,
      preserveRecordingState: true,
      stopTracks: true,
    });

      try {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 350);
        });

        recordingStartTimeRef.current = preservedStartTime;
        isRestartingRecorderRef.current = false;
        setError(null);
        await startRecordingRef.current?.();
      } catch {
      shouldKeepRecordingRef.current = false;
      setError(ERROR_MIC_PERMISSION_REVOKED);
      releaseCaptureResources({
        preserveDuration: false,
        preserveRecordingState: false,
        stopTracks: true,
      });
      } finally {
        isRestartingRecorderRef.current = false;
      }
  }, [releaseCaptureResources, showNotice]);

  const stopRecording = useCallback(() => {
    shouldKeepRecordingRef.current = false;

    const mediaRecorder = mediaRecorderRef.current;

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      releaseCaptureResources({
        preserveDuration: false,
        preserveRecordingState: false,
        stopTracks: true,
      });

      return;
    }

    mediaRecorder.stop();
  }, [releaseCaptureResources]);

  useEffect(
    () => () => {
      shouldKeepRecordingRef.current = false;
      pendingWindowsRef.current = [];
      completedWindowsRef.current = [];
      clearNoticeTimer();
      releaseCaptureResources({
        preserveDuration: false,
        preserveRecordingState: false,
        stopTracks: true,
      });
    },
    [clearNoticeTimer, releaseCaptureResources],
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isRecordingRef.current) {
        dispatchAudioDebugEvent("background-recording");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (typeof window === "undefined") {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === "undefined") {
      setError(ERROR_BROWSER_UNSUPPORTED);

      return;
    }

    if (isRecordingRef.current || isRestartingRecorderRef.current) {
      return;
    }

    try {
      setError(null);
      shouldKeepRecordingRef.current = true;

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16_000,
        },
      });
      const audioTrack = mediaStream.getAudioTracks()[0];

      if (!audioTrack) {
        mediaStream.getTracks().forEach((track) => track.stop());
        setError(ERROR_MIC_NOT_FOUND);

        return;
      }

      audioTrack.onended = () => {
        if (!shouldKeepRecordingRef.current) {
          return;
        }

        shouldKeepRecordingRef.current = false;
        setError(ERROR_MIC_PERMISSION_REVOKED);
        releaseCaptureResources({
          preserveDuration: true,
          preserveRecordingState: false,
          stopTracks: true,
        });
      };

      const AudioContextClass = resolveAudioContext();

      if (!AudioContextClass) {
        mediaStream.getTracks().forEach((track) => track.stop());
        setError(ERROR_BROWSER_UNSUPPORTED);

        return;
      }

      const audioContext = new AudioContextClass();
      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const analyserNode = audioContext.createAnalyser();
      const recorderOptions = resolveRecorderOptions();
      const mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);

      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.8;
      sourceNode.connect(analyserNode);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size === 0) {
          return;
        }

        handleAudioSlice(event.data);
      };

      mediaRecorder.onerror = () => {
        void restartRecorderSession();
      };

      mediaRecorder.onstop = () => {
        if (shouldKeepRecordingRef.current && isChunkRolloverRef.current) {
          isChunkRolloverRef.current = false;

          try {
            mediaRecorder.start();
            scheduleChunkFlush(mediaRecorder);
          } catch {
            void restartRecorderSession();
          }

          return;
        }

        if (!shouldKeepRecordingRef.current) {
          releaseCaptureResources({
            preserveDuration: false,
            preserveRecordingState: false,
            stopTracks: true,
          });
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaStreamRef.current = mediaStream;
      audioContextRef.current = audioContext;
      analyserNodeRef.current = analyserNode;
      sourceNodeRef.current = sourceNode;

      const startedAt = recordingStartTimeRef.current ?? Date.now();

      recordingStartTimeRef.current = startedAt;
      durationIntervalRef.current = window.setInterval(() => {
        if (recordingStartTimeRef.current === null) {
          return;
        }

        setRecordingDurationMs(Date.now() - recordingStartTimeRef.current);
      }, 1_000);

      const timeDomainData = new Float32Array(analyserNode.fftSize);

      vadIntervalRef.current = window.setInterval(() => {
        analyserNode.getFloatTimeDomainData(timeDomainData);

        const rms = computeRms(timeDomainData);
        const timestampMs = Date.now();

        vadFramesRef.current.push({ rms, timestampMs });
        vadFramesRef.current = pruneVadFrames(vadFramesRef.current, timestampMs - VAD_WINDOW_MS);
        setIsSpeaking(rms > vadThreshold);
      }, VAD_FRAME_INTERVAL_MS);

      mediaRecorder.start();
      scheduleChunkFlush(mediaRecorder);
      setIsRecording(true);
      setRecordingDurationMs(Date.now() - startedAt);
    } catch (errorValue) {
      shouldKeepRecordingRef.current = false;
      releaseCaptureResources({
        preserveDuration: false,
        preserveRecordingState: false,
        stopTracks: true,
      });

      if (errorValue instanceof DOMException && errorValue.name === "NotAllowedError") {
        setError(ERROR_MIC_PERMISSION_DENIED);

        return;
      }

      if (errorValue instanceof DOMException && errorValue.name === "NotFoundError") {
        setError(ERROR_MIC_NOT_FOUND);

        return;
      }

      setError("Unable to start microphone recording in this browser session.");
    }
  }, [handleAudioSlice, releaseCaptureResources, restartRecorderSession, scheduleChunkFlush, vadThreshold]);

  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  useEffect(() => {
    restartRecorderSessionRef.current = restartRecorderSession;
  }, [restartRecorderSession]);

  const flushPendingChunk = useCallback(async () => {
    const mediaRecorder = mediaRecorderRef.current;

    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      return;
    }

    isChunkRolloverRef.current = true;

    try {
      mediaRecorder.stop();
    } catch {
      isChunkRolloverRef.current = false;
      return;
    }

    const FLUSH_TIMEOUT_MS = 2500;
    const POLL_INTERVAL_MS = 80;
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;

    await new Promise<void>((resolve) => {
      const check = () => {
        const idle =
          inFlightCountRef.current === 0 && pendingWindowsRef.current.length === 0;

        if (idle || Date.now() >= deadline) {
          if (Date.now() >= deadline) {
            console.warn("[TwinMind][audio][flush] timed out waiting for transcription to settle");
          }
          resolve();
          return;
        }

        window.setTimeout(check, POLL_INTERVAL_MS);
      };

      check();
    });
  }, []);

  const clearTranscript = useCallback(() => {
    transcriptGenerationRef.current += 1;
    pendingWindowsRef.current = [];
    completedWindowsRef.current = [];
    lastTranscriptTailRef.current = "";
    updateTranscriptionActivityState();
    baseClearTranscript();
  }, [baseClearTranscript, updateTranscriptionActivityState]);

  return {
    clearTranscript,
    committedTranscript,
    error,
    flushPendingChunk,
    isRecording,
    isSpeaking,
    isTranscribing,
    recordingDurationMs,
    startRecording,
    stopRecording,
    transcriptionNotice,
    transcript,
  };
}
