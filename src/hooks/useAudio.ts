"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranscript } from "@/hooks/useTranscript";
import type { TranscriptChunk, TranscribeResponse } from "@/lib/types";

type UseAudioOptions = {
  chunkDurationMs?: number;
  groqApiKey?: string;
  onAudioChunk?: (blob: Blob, timestamp: Date) => void;
  onTranscript?: (chunk: TranscriptChunk) => void;
};

type UseAudioResult = {
  clearTranscript: () => void;
  error: string | null;
  isRecording: boolean;
  recordingDurationMs: number;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  transcriptionNotice: string | null;
  transcript: TranscriptChunk[];
};

const DEFAULT_CHUNK_DURATION_MS = 8_000;
const ERROR_BROWSER_UNSUPPORTED =
  "This browser does not support microphone recording with MediaRecorder.";
const ERROR_MIC_PERMISSION_DENIED =
  "Mic access denied. Allow microphone permissions and try again.";
const ERROR_MIC_NOT_FOUND = "No microphone was detected on this device.";
const TRANSCRIPTION_RETRY_NOTICE = "Failed to transcribe audio, retrying...";
const TRANSCRIPTION_FAILURE_NOTICE = "Unable to transcribe. Check API key.";

type BrowserAudioContextConstructor = new () => AudioContext;
type BrowserWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: BrowserAudioContextConstructor;
  };

type PendingTranscriptionChunk = {
  attempt: number;
  audioBlob: Blob;
  timestamp: Date;
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

export function useAudio({
  chunkDurationMs = DEFAULT_CHUNK_DURATION_MS,
  groqApiKey,
  onAudioChunk,
  onTranscript,
}: UseAudioOptions = {}): UseAudioResult {
  const { addChunk, clearTranscript, transcript } = useTranscript();
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [transcriptionNotice, setTranscriptionNotice] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const durationIntervalRef = useRef<number | null>(null);
  const transcriptionQueueRef = useRef<PendingTranscriptionChunk[]>([]);
  const isTranscribingRef = useRef(false);
  const noticeTimeoutRef = useRef<number | null>(null);

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
      }, 4000);
    },
    [clearNoticeTimer],
  );

  const cleanupMediaResources = useCallback(() => {
    clearDurationInterval();
    clearNoticeTimer();

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
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    recordingStartTimeRef.current = null;
    transcriptionQueueRef.current = [];
    isTranscribingRef.current = false;
    setTranscriptionNotice(null);
    setRecordingDurationMs(0);
    setIsRecording(false);
  }, [clearDurationInterval, clearNoticeTimer]);

  const processTranscriptionQueue = useCallback(async () => {
    if (isTranscribingRef.current) {
      return;
    }

    const nextChunk = transcriptionQueueRef.current.shift();

    if (!nextChunk) {
      return;
    }

    isTranscribingRef.current = true;

    try {
      const formData = new FormData();

      formData.append("audio", nextChunk.audioBlob, "chunk.webm");

      const response = await fetch("/api/transcribe", {
        body: formData,
        headers: groqApiKey ? { "x-groq-api-key": groqApiKey } : undefined,
        method: "POST",
      });

      const payload = (await response.json()) as TranscribeResponse;

      if (!response.ok) {
        throw new Error(payload.error || "Transcription request failed.");
      }

      const transcriptText = payload.text.trim();

      if (transcriptText) {
        const parsedTimestamp = new Date(payload.timestamp);
        const chunk = addChunk(transcriptText, {
          speaker: "Meeting",
          timestamp:
            Number.isNaN(parsedTimestamp.getTime()) ? nextChunk.timestamp : parsedTimestamp,
        });

        if (chunk) {
          onTranscript?.(chunk);
        }
      }

      showNotice(null);
    } catch (errorValue) {
      if (isNetworkError(errorValue) && nextChunk.attempt < 1) {
        transcriptionQueueRef.current.unshift({
          ...nextChunk,
          attempt: nextChunk.attempt + 1,
        });
        showNotice(TRANSCRIPTION_RETRY_NOTICE);
      } else {
        showNotice(TRANSCRIPTION_FAILURE_NOTICE);
      }
    } finally {
      isTranscribingRef.current = false;

      if (transcriptionQueueRef.current.length > 0) {
        void processTranscriptionQueue();
      }
    }
  }, [addChunk, groqApiKey, onTranscript, showNotice]);

  const stopRecording = () => {
    const mediaRecorder = mediaRecorderRef.current;

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      cleanupMediaResources();

      return;
    }

    mediaRecorder.stop();
  };

  useEffect(
    () => () => {
      cleanupMediaResources();
    },
    [cleanupMediaResources],
  );

  const startRecording = async () => {
    if (typeof window === "undefined") {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === "undefined") {
      setError(ERROR_BROWSER_UNSUPPORTED);

      return;
    }

    if (isRecording) {
      return;
    }

    try {
      setError(null);
      setRecordingDurationMs(0);

      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const hasAudioTrack = mediaStream.getAudioTracks().length > 0;

      if (!hasAudioTrack) {
        mediaStream.getTracks().forEach((track) => track.stop());
        setError(ERROR_MIC_NOT_FOUND);

        return;
      }

      const AudioContextClass = resolveAudioContext();

      if (!AudioContextClass) {
        mediaStream.getTracks().forEach((track) => track.stop());
        setError(ERROR_BROWSER_UNSUPPORTED);

        return;
      }

      const audioContext = new AudioContextClass();
      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const analyserNode = audioContext.createAnalyser();

      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.8;
      sourceNode.connect(analyserNode);

      const mediaRecorder = new MediaRecorder(mediaStream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size === 0) {
          return;
        }

        const chunkTimestamp = new Date();

        onAudioChunk?.(event.data, chunkTimestamp);
        transcriptionQueueRef.current.push({
          attempt: 0,
          audioBlob: event.data,
          timestamp: chunkTimestamp,
        });
        void processTranscriptionQueue();
      };

      mediaRecorder.onerror = () => {
        setError("Microphone capture failed while recording. Stop and try again.");
        cleanupMediaResources();
      };

      mediaRecorder.onstop = () => {
        cleanupMediaResources();
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaStreamRef.current = mediaStream;
      audioContextRef.current = audioContext;
      analyserNodeRef.current = analyserNode;
      sourceNodeRef.current = sourceNode;

      recordingStartTimeRef.current = Date.now();
      durationIntervalRef.current = window.setInterval(() => {
        if (recordingStartTimeRef.current === null) {
          return;
        }

        setRecordingDurationMs(Date.now() - recordingStartTimeRef.current);
      }, 1000);

      mediaRecorder.start(chunkDurationMs);
      setIsRecording(true);
    } catch (errorValue) {
      cleanupMediaResources();

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
  };

  return {
    clearTranscript,
    error,
    isRecording,
    recordingDurationMs,
    startRecording,
    stopRecording,
    transcriptionNotice,
    transcript,
  };
}
