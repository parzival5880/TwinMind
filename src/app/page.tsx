"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioRecorder } from "@/components/AudioRecorder";
import { ChatPanel } from "@/components/ChatPanel";
import { ExportButton } from "@/components/ExportButton";
import { HelpModal } from "@/components/HelpModal";
import { SettingsModal } from "@/components/SettingsModal";
import { SuggestionsPanel } from "@/components/SuggestionsPanel";
import { TelemetryPanel } from "@/components/TelemetryPanel";
import { ToastViewport } from "@/components/ToastViewport";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { useAudio } from "@/hooks/useAudio";
import { useChat } from "@/hooks/useChat";
import { useMeetingClassifier } from "@/hooks/useMeetingClassifier";
import { useRollingSummary } from "@/hooks/useRollingSummary";
import { useSalienceStore } from "@/hooks/useSalienceStore";
import { useSettings } from "@/hooks/useSettings";
import { useSuggestions } from "@/hooks/useSuggestions";
import { useToastQueue } from "@/hooks/useToastQueue";
import type { RollingSummary, SalientMoment, Suggestion, SuggestionMeta } from "@/lib/types";

type MobileTab = "transcript" | "suggestions" | "chat";
type TranscriptJumpTarget = {
  requestId: number;
  timestamp: string;
};

const formatRecordingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
};

export default function HomePage() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>("transcript");
  const [isDebugEnabled] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1",
  );
  const [transcriptJumpTarget, setTranscriptJumpTarget] = useState<TranscriptJumpTarget | null>(
    null,
  );
  const [showSettingsRestartBanner, setShowSettingsRestartBanner] = useState(false);
  const [isWaitingForSpeech, setIsWaitingForSpeech] = useState(false);
  const { pushToast, removeToast, toasts } = useToastQueue();
  const {
    defaultSettings,
    feedback,
    fieldErrors,
    isLoaded,
    isSaving,
    resetSettings,
    settings,
    updateSettings,
  } = useSettings();
  const {
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
  } = useAudio({
    groqApiKey: settings.groq_api_key,
  });
  const [isRefreshingTranscript, setIsRefreshingTranscript] = useState(false);
  const {
    cancelSuggestions,
    error: suggestionsError,
    generateSuggestions,
    isLoading: isSuggestionsLoading,
    suggestions,
  } = useSuggestions({
    contextWindow: settings.context_window_suggestions,
    groqApiKey: settings.groq_api_key,
    promptTemplate: settings.live_suggestion_prompt,
    pauseWhileChatInflight: () => isChatLoadingRef.current,
  });
  const {
    addSuggestionAsMessage,
    error: chatError,
    isLoading: isChatLoading,
    messages,
    retryMessage,
    sendMessage,
  } = useChat({
    chatPromptTemplate: settings.chat_prompt,
    contextWindow: settings.context_window_answers,
    detailedAnswerPromptTemplate: settings.detailed_answer_prompt,
    groqApiKey: settings.groq_api_key,
  });
  const { resetSummary, rollingSummary } = useRollingSummary({
    enabled: isRecording,
    groqApiKey: settings.groq_api_key,
    transcript: committedTranscript,
  });
  const { classifiedType } = useMeetingClassifier({
    enabled: isRecording,
    groqApiKey: settings.groq_api_key,
    recordingDurationMs,
    transcript: committedTranscript,
  });
  const { moments: salientMoments, reset: resetSalience } = useSalienceStore({
    chunks: committedTranscript,
    isRecording,
    apiKey: settings.groq_api_key,
  });
  const transcriptSignature = useMemo(
    () =>
      committedTranscript
        .map((chunk) => `${chunk.timestamp.toISOString()}::${chunk.text}`)
        .join("\n"),
    [committedTranscript],
  );
  const recentChatTopics = useMemo(() => {
    // Surface the last few user messages as "current chat focus" so the
    // suggestion model can bias toward topics the user is actively curious
    // about. Assistant replies are deliberately excluded — they would bias
    // toward self-reinforcing answers.
    const recentUserMessages = messages
      .filter((message) => message.role === "user")
      .slice(-3)
      .map((message) => message.content.trim())
      .filter(Boolean);

    if (recentUserMessages.length === 0) {
      return "";
    }

    return recentUserMessages
      .map((content, index) => `${index + 1}. ${content}`)
      .join("\n");
  }, [messages]);
  const latestSuggestionMeta = useMemo(() => suggestions[0]?.meta, [suggestions]);
  const lastGeneratedSignatureRef = useRef("");
  const transcriptSignatureRef = useRef(transcriptSignature);
  const isRecordingRef = useRef(isRecording);
  const rollingSummaryRef = useRef<RollingSummary | null>(rollingSummary);
  const recentChatTopicsRef = useRef(recentChatTopics);
  const salientMemoryRef = useRef<SalientMoment[]>([]);
  const latestSuggestionMetaRef = useRef<SuggestionMeta | undefined>(latestSuggestionMeta);
  const silenceTimeoutRef = useRef<number | null>(null);
  const silenceResetTimeoutRef = useRef<number | null>(null);
  const lastAudioErrorRef = useRef<string | null>(null);
  const lastSuggestionsErrorRef = useRef<string | null>(null);
  const lastChatErrorRef = useRef<string | null>(null);
  const lastTranscriptionNoticeRef = useRef<string | null>(null);
  const isChatLoadingRef = useRef(isChatLoading);
  const sessionState = useMemo(
    () => ({
      transcript,
      suggestions,
      chat: messages,
      isRecording,
    }),
    [isRecording, messages, suggestions, transcript],
  );

  useEffect(() => {
    transcriptSignatureRef.current = transcriptSignature;
  }, [transcriptSignature]);

  useEffect(() => {
    isChatLoadingRef.current = isChatLoading;
  }, [isChatLoading]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    rollingSummaryRef.current = rollingSummary;
  }, [rollingSummary]);

  useEffect(() => {
    recentChatTopicsRef.current = recentChatTopics;
  }, [recentChatTopics]);

  useEffect(() => {
    salientMemoryRef.current = salientMoments;
  }, [salientMoments]);

  useEffect(() => {
    latestSuggestionMetaRef.current = latestSuggestionMeta;
  }, [latestSuggestionMeta]);

  useEffect(() => {
    const scheduleWaitingReset = () => {
      if (silenceResetTimeoutRef.current !== null) {
        window.clearTimeout(silenceResetTimeoutRef.current);
      }

      silenceResetTimeoutRef.current = window.setTimeout(() => {
        setIsWaitingForSpeech(false);
        silenceResetTimeoutRef.current = null;
      }, 0);
    };

    if (!isRecording) {
      if (silenceTimeoutRef.current !== null) {
        window.clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }
      scheduleWaitingReset();

      return;
    }

    if (isSpeaking) {
      if (silenceTimeoutRef.current !== null) {
        window.clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }
      scheduleWaitingReset();

      return;
    }

    silenceTimeoutRef.current = window.setTimeout(() => {
      setIsWaitingForSpeech(true);
      silenceTimeoutRef.current = null;
    }, 5_000);

    return () => {
      if (silenceTimeoutRef.current !== null) {
        window.clearTimeout(silenceTimeoutRef.current);
        silenceTimeoutRef.current = null;
      }
      if (silenceResetTimeoutRef.current !== null) {
        window.clearTimeout(silenceResetTimeoutRef.current);
        silenceResetTimeoutRef.current = null;
      }
    };
  }, [isRecording, isSpeaking]);

  const handleGenerateSuggestions = useCallback(
    async (source: "auto" | "manual" = "manual") => {
      const batch = await generateSuggestions(
        committedTranscript,
        {
          rollingSummary: rollingSummaryRef.current,
          recentChatTopics: recentChatTopicsRef.current,
          salientMemory: salientMemoryRef.current,
          meetingType: latestSuggestionMetaRef.current?.meeting_type ?? classifiedType ?? "default",
          conversationStage: latestSuggestionMetaRef.current?.conversation_stage ?? "unclear",
        },
        {
          replacePending: source === "manual",
          source,
        },
      );

      if (batch) {
        lastGeneratedSignatureRef.current = transcriptSignature;
      }
    },
    [classifiedType, committedTranscript, generateSuggestions, transcriptSignature],
  );
  const handleGenerateSuggestionsRef = useRef(handleGenerateSuggestions);

  useEffect(() => {
    handleGenerateSuggestionsRef.current = handleGenerateSuggestions;
  }, [handleGenerateSuggestions]);

  const buildChatContextOptions = useCallback(
    (meta?: SuggestionMeta) => ({
      rollingSummary: rollingSummaryRef.current,
      salientMemory: salientMemoryRef.current,
      suggestionMeta: meta ?? latestSuggestionMetaRef.current,
    }),
    [],
  );

  useEffect(() => {
    if (!isRecording) {
      cancelSuggestions();
      return;
    }

    const maybeGenerateSuggestions = () => {
      if (!isRecordingRef.current) {
        return;
      }

      if (
        transcriptSignatureRef.current.length === 0 ||
        transcriptSignatureRef.current === lastGeneratedSignatureRef.current
      ) {
        return;
      }

      void handleGenerateSuggestionsRef.current("auto");
    };

    let intervalId: number | null = null;
    const warmupId = window.setTimeout(() => {
      maybeGenerateSuggestions();
      intervalId = window.setInterval(() => {
        maybeGenerateSuggestions();
      }, 30_000);
    }, 28_000);

    return () => {
      window.clearTimeout(warmupId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [cancelSuggestions, isRecording]);

  const handleManualRefresh = useCallback(async () => {
    cancelSuggestions();
    if (isRecording) {
      setIsRefreshingTranscript(true);
      try {
        await flushPendingChunk();
      } finally {
        setIsRefreshingTranscript(false);
      }
    }
    void handleGenerateSuggestions("manual");
  }, [cancelSuggestions, flushPendingChunk, handleGenerateSuggestions, isRecording]);

  const openSettings = useCallback(() => {
    setIsHelpOpen(false);
    setIsSettingsOpen(true);
  }, []);

  const handleStartRecording = useCallback(async () => {
    setActiveMobileTab("transcript");
    await startRecording();
  }, [startRecording]);

  const handleStopRecording = useCallback(() => {
    stopRecording();
    setShowSettingsRestartBanner(false);
  }, [stopRecording]);

  const handleClearTranscript = useCallback(() => {
    clearTranscript();
    resetSummary();
    resetSalience();
    lastGeneratedSignatureRef.current = "";
    setShowSettingsRestartBanner(false);
  }, [clearTranscript, resetSalience, resetSummary]);

  const handleSaveSettings = useCallback(
    async (nextSettings: typeof settings) => {
      const didChange = JSON.stringify(nextSettings) !== JSON.stringify(settings);
      const saved = await updateSettings(nextSettings);

      if (!saved) {
        pushToast({
          action: {
            label: "Open Settings",
            onAction: openSettings,
          },
          message: "Settings were not saved. Fix the highlighted issues and try again.",
          tone: "error",
          title: "Settings error",
        });

        return false;
      }

      pushToast({
        message: "Settings saved successfully.",
        tone: "success",
        title: "Saved",
      });

      if (didChange && (isRecording || transcript.length > 0)) {
        setShowSettingsRestartBanner(true);
      }

      return true;
    },
    [isRecording, openSettings, pushToast, settings, transcript.length, updateSettings],
  );

  const handleResetSettings = useCallback(() => {
    resetSettings();
    setShowSettingsRestartBanner(false);
    pushToast({
      message: "Defaults restored. New transcriptions will use the default settings.",
      tone: "info",
      title: "Defaults restored",
    });
  }, [pushToast, resetSettings]);

  const handleCopySuggestion = useCallback(
    async (suggestion: Suggestion) => {
      try {
        await navigator.clipboard.writeText(suggestion.preview);
        pushToast({
          message: "Suggestion preview copied to your clipboard.",
          tone: "success",
          title: "Copied",
        });
      } catch {
        pushToast({
          message: "Clipboard access failed. Try copying the preview manually.",
          tone: "warning",
          title: "Copy unavailable",
        });
      }
    },
    [pushToast],
  );

  const handleDismissSuggestion = useCallback(
    (suggestion: Suggestion) => {
      pushToast({
        message: `"${suggestion.preview}" was dismissed from this session view.`,
        tone: "info",
        title: "Suggestion dismissed",
      });
    },
    [pushToast],
  );

  const lastRetryableAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (message.role === "assistant" && message.streamError) {
        return message.id;
      }
    }

    return null;
  }, [messages]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Recording in progress. Exit anyway?";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isRecording]);

  useEffect(() => {
    if (!error) {
      lastAudioErrorRef.current = null;
    }
  }, [error]);

  useEffect(() => {
    if (!error || lastAudioErrorRef.current === error) {
      return;
    }

    lastAudioErrorRef.current = error;
    pushToast({
      action: error.toLowerCase().includes("grant mic access")
        ? {
            label: "Open Settings",
            onAction: openSettings,
          }
        : undefined,
      message: error,
      tone: "error",
      title: "Microphone issue",
    });
  }, [error, openSettings, pushToast]);

  useEffect(() => {
    if (!suggestionsError) {
      lastSuggestionsErrorRef.current = null;
    }
  }, [suggestionsError]);

  useEffect(() => {
    if (!suggestionsError || lastSuggestionsErrorRef.current === suggestionsError) {
      return;
    }

    lastSuggestionsErrorRef.current = suggestionsError;
    pushToast({
      action: suggestionsError.toLowerCase().includes("api key")
        ? {
            label: "Open Settings",
            onAction: openSettings,
          }
        : {
            label: "Retry",
            onAction: handleManualRefresh,
          },
      message: suggestionsError,
      tone: "error",
      title: "Suggestions failed",
    });
  }, [handleManualRefresh, openSettings, pushToast, suggestionsError]);

  useEffect(() => {
    if (!chatError) {
      lastChatErrorRef.current = null;
    }
  }, [chatError]);

  useEffect(() => {
    if (!chatError || lastChatErrorRef.current === chatError) {
      return;
    }

    lastChatErrorRef.current = chatError;
    pushToast({
      action: chatError.toLowerCase().includes("api key")
        ? {
            label: "Open Settings",
            onAction: openSettings,
          }
        : lastRetryableAssistantId
          ? {
              label: "Retry",
              onAction: () => {
                void retryMessage(lastRetryableAssistantId, transcript);
              },
            }
          : undefined,
      message: chatError,
      tone: "error",
      title: "Chat failed",
    });
  }, [chatError, lastRetryableAssistantId, openSettings, pushToast, retryMessage, transcript]);

  useEffect(() => {
    if (!transcriptionNotice) {
      lastTranscriptionNoticeRef.current = null;
    }
  }, [transcriptionNotice]);

  useEffect(() => {
    if (!transcriptionNotice || lastTranscriptionNoticeRef.current === transcriptionNotice) {
      return;
    }

    lastTranscriptionNoticeRef.current = transcriptionNotice;
    const normalizedNotice = transcriptionNotice.toLowerCase();

    pushToast({
      action: normalizedNotice.includes("api key")
        ? {
            label: "Open Settings",
            onAction: openSettings,
          }
        : normalizedNotice.includes("lagging")
          ? {
              label: "Refresh Suggestions",
              onAction: handleManualRefresh,
            }
          : undefined,
      message: transcriptionNotice,
      tone: normalizedNotice.includes("lagging")
        ? "warning"
        : normalizedNotice.includes("retrying")
          ? "info"
          : "error",
      title: "Transcription update",
    });
  }, [handleManualRefresh, openSettings, pushToast, transcriptionNotice]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isModifierPressed = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const isEditableTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.closest("[contenteditable='true']"));

      if (event.key === "Escape") {
        setIsHelpOpen(false);
        setIsSettingsOpen(false);
        return;
      }

      if (!isModifierPressed) {
        if (event.key === "?" && !isEditableTarget) {
          event.preventDefault();
          setIsHelpOpen(true);
        }

        return;
      }

      const normalizedKey = event.key.toLowerCase();

      if (normalizedKey === "k") {
        event.preventDefault();
        setActiveMobileTab("chat");
        window.setTimeout(() => {
          document.querySelector<HTMLTextAreaElement>("[data-chat-input='true']")?.focus();
        }, 0);
      }

      if (normalizedKey === "r") {
        event.preventDefault();
        void handleManualRefresh();
      }

      if (normalizedKey === "m") {
        event.preventDefault();
        if (isRecordingRef.current) {
          stopRecording();
        } else {
          void handleStartRecording();
        }
      }

      if (normalizedKey === "e") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>("[data-export-button='true']")?.click();
      }
    };

    window.addEventListener("keydown", handleKeydown);

    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [handleManualRefresh, handleStartRecording, stopRecording]);

  const mobileTabs = [
    { id: "transcript" as const, label: `Transcript (${transcript.length})` },
    { id: "suggestions" as const, label: `Suggestions (${suggestions.length})` },
    { id: "chat" as const, label: `Chat (${messages.length})` },
  ];
  const handleJumpToTimestamp = useCallback((timestamp: string) => {
    setActiveMobileTab("transcript");
    setTranscriptJumpTarget({
      timestamp,
      requestId: Date.now(),
    });
  }, []);

  return (
    <>
      <ToastViewport onDismiss={removeToast} toasts={toasts} />

      <main className="mx-auto flex min-h-screen w-full max-w-[1920px] flex-col px-3 py-3 sm:px-4 sm:py-4 lg:px-6 lg:py-6">
        <section className="soft-panel sticky top-3 z-40 mb-4 rounded-[2rem] px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-4">
              <Link
                aria-label="TwinMind home"
                className="flex items-center gap-3 rounded-[1.5rem] px-1 py-1 hover:bg-white/60"
                href="/"
              >
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-sm font-semibold text-white shadow-sm">
                  TM
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">
                    Meeting Copilot
                  </p>
                  <h1 className="text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">
                    TwinMind
                  </h1>
                </div>
              </Link>
            </div>

            <div className="flex items-center justify-center xl:flex-1">
              <div
                aria-live="polite"
                className="flex min-w-[220px] items-center justify-center gap-3 rounded-full border border-slate-200 bg-slate-50/90 px-5 py-3 shadow-sm"
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-3.5 w-3.5 rounded-full ${
                    isRecording && !isWaitingForSpeech
                      ? "animate-pulse bg-rose-500 shadow-[0_0_0_8px_rgba(244,63,94,0.14)]"
                      : isRecording
                        ? "bg-slate-400 shadow-[0_0_0_8px_rgba(148,163,184,0.12)]"
                        : "bg-slate-300"
                  }`}
                />
                <div className="text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Recording Status
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {isRecording
                      ? isWaitingForSpeech
                        ? "Listening · waiting for speech"
                        : `Recording · ${formatRecordingDuration(recordingDurationMs)}`
                      : "Not Recording"}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                aria-label="Open keyboard shortcuts help"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-slate-950 hover:text-slate-950"
                type="button"
                onClick={() => setIsHelpOpen(true)}
              >
                ? Help
              </button>
              <button
                aria-label="Open settings modal"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-slate-950 hover:text-slate-950"
                type="button"
                onClick={openSettings}
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 3.75a2.25 2.25 0 0 1 2.18 1.68l.18.7a2.25 2.25 0 0 0 2.72 1.59l.71-.17a2.25 2.25 0 0 1 2.63 3.03l-.29.68a2.25 2.25 0 0 0 .66 2.94l.59.43a2.25 2.25 0 0 1 0 3.64l-.59.43a2.25 2.25 0 0 0-.66 2.94l.29.68a2.25 2.25 0 0 1-2.63 3.03l-.71-.17a2.25 2.25 0 0 0-2.72 1.59l-.18.7a2.25 2.25 0 0 1-4.36 0l-.18-.7a2.25 2.25 0 0 0-2.72-1.59l-.71.17a2.25 2.25 0 0 1-2.63-3.03l.29-.68a2.25 2.25 0 0 0-.66-2.94l-.59-.43a2.25 2.25 0 0 1 0-3.64l.59-.43a2.25 2.25 0 0 0 .66-2.94l-.29-.68a2.25 2.25 0 0 1 2.63-3.03l.71.17a2.25 2.25 0 0 0 2.72-1.59l.18-.7A2.25 2.25 0 0 1 12 3.75Z" />
                  <path d="M12 15.75A3.75 3.75 0 1 0 12 8.25a3.75 3.75 0 0 0 0 7.5Z" />
                </svg>
                Settings
              </button>
              <ExportButton
                buttonId="export-session-button"
                className="items-stretch"
                onExport={() => {
                  pushToast({
                    message: "Session exported successfully.",
                    tone: "success",
                    title: "Export ready",
                  });
                }}
                session={sessionState}
              />
            </div>
          </div>
        </section>

        {showSettingsRestartBanner ? (
          <div className="mb-4 rounded-[1.5rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Changes will apply to the next transcription.
          </div>
        ) : null}

        <nav
          aria-label="Mobile workspace tabs"
          className="tab-scroller mb-4 flex gap-2 overflow-x-auto md:hidden"
        >
          {mobileTabs.map((tab) => (
            <button
              key={tab.id}
              aria-pressed={activeMobileTab === tab.id}
              className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold shadow-sm ${
                activeMobileTab === tab.id
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white/90 text-slate-700"
              }`}
              type="button"
              onClick={() => setActiveMobileTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <section className="meeting-workspace hidden flex-1 md:grid">
          <div className="flex min-h-0 flex-col gap-6 md:row-span-2 xl:row-span-1 xl:pr-6">
            <AudioRecorder
              error={error}
              isRecording={isRecording}
              isSpeaking={isSpeaking}
              isTranscribing={isTranscribing}
              recordingDurationMs={recordingDurationMs}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
              transcriptionNotice={transcriptionNotice}
            />
            <TranscriptPanel
              chunks={transcript}
              error={error}
              isRecording={isRecording}
              jumpTarget={transcriptJumpTarget}
              onClear={handleClearTranscript}
            />
          </div>

          <div className="min-h-0 md:col-start-2 md:border-l md:border-slate-200 md:pl-6 xl:border-l xl:border-r xl:border-slate-200 xl:px-6">
            <SuggestionsPanel
              error={suggestionsError}
              isLoading={isSuggestionsLoading}
              isRefreshingTranscript={isRefreshingTranscript}
              onCopySuggestion={(suggestion) => {
                void handleCopySuggestion(suggestion);
              }}
              onDismissSuggestion={handleDismissSuggestion}
              onOpenSettings={openSettings}
              onRefresh={handleManualRefresh}
              onSuggestionSelected={(suggestion, meta) => {
                void addSuggestionAsMessage(
                  suggestion,
                  committedTranscript,
                  buildChatContextOptions(meta),
                );
              }}
              suggestionBatches={suggestions}
            />
          </div>

          <div className="min-h-0 md:col-start-2 md:border-l md:border-slate-200 md:pl-6 xl:col-start-auto xl:border-l xl:border-slate-200 xl:pl-6">
            <ChatPanel
              error={chatError}
              inputId="chat-input-desktop"
              isLoading={isChatLoading}
              messages={messages}
              onJumpToTimestamp={handleJumpToTimestamp}
              onOpenSettings={openSettings}
              onRetryMessage={(messageId, currentTranscript) => {
                void retryMessage(messageId, currentTranscript, buildChatContextOptions());
              }}
              onSendMessage={(message, currentTranscript) => {
                void sendMessage(message, currentTranscript, buildChatContextOptions());
              }}
              transcript={committedTranscript}
            />
          </div>
        </section>

        <section className="flex flex-1 flex-col gap-4 md:hidden">
          <AudioRecorder
            error={error}
            isRecording={isRecording}
            isSpeaking={isSpeaking}
            isTranscribing={isTranscribing}
            recordingDurationMs={recordingDurationMs}
            onStartRecording={handleStartRecording}
            onStopRecording={handleStopRecording}
            transcriptionNotice={transcriptionNotice}
          />

          {activeMobileTab === "transcript" ? (
            <TranscriptPanel
              chunks={transcript}
              error={error}
              isRecording={isRecording}
              jumpTarget={transcriptJumpTarget}
              onClear={handleClearTranscript}
            />
          ) : null}

          {activeMobileTab === "suggestions" ? (
            <SuggestionsPanel
              error={suggestionsError}
              isLoading={isSuggestionsLoading}
              isRefreshingTranscript={isRefreshingTranscript}
              onCopySuggestion={(suggestion) => {
                void handleCopySuggestion(suggestion);
              }}
              onDismissSuggestion={handleDismissSuggestion}
              onOpenSettings={openSettings}
              onRefresh={handleManualRefresh}
              onSuggestionSelected={(suggestion, meta) => {
                void addSuggestionAsMessage(
                  suggestion,
                  committedTranscript,
                  buildChatContextOptions(meta),
                );
              }}
              suggestionBatches={suggestions}
            />
          ) : null}

          {activeMobileTab === "chat" ? (
            <ChatPanel
              error={chatError}
              inputId="chat-input-mobile"
              isLoading={isChatLoading}
              messages={messages}
              onJumpToTimestamp={handleJumpToTimestamp}
              onOpenSettings={openSettings}
              onRetryMessage={(messageId, currentTranscript) => {
                void retryMessage(messageId, currentTranscript, buildChatContextOptions());
              }}
              onSendMessage={(message, currentTranscript) => {
                void sendMessage(message, currentTranscript, buildChatContextOptions());
              }}
              transcript={committedTranscript}
            />
          ) : null}
        </section>

        {isDebugEnabled ? <TelemetryPanel /> : null}

        <footer className="px-1 py-4 text-center text-xs uppercase tracking-[0.16em] text-slate-400">
          Powered by Groq · gpt-oss-120b · whisper-large-v3
        </footer>
      </main>

      <SettingsModal
        defaultSettings={defaultSettings}
        feedback={feedback}
        fieldErrors={fieldErrors}
        isOpen={isSettingsOpen}
        isLoaded={isLoaded}
        isSaving={isSaving}
        onClose={() => setIsSettingsOpen(false)}
        onResetSettings={handleResetSettings}
        onSaveSettings={handleSaveSettings}
        settings={settings}
      />
      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </>
  );
}
