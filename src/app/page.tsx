"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioRecorder } from "@/components/AudioRecorder";
import { ChatPanel } from "@/components/ChatPanel";
import { ExportButton } from "@/components/ExportButton";
import { HelpModal } from "@/components/HelpModal";
import { SuggestionPipelineDebugPanel } from "@/components/SuggestionPipelineDebugPanel";
import { SuggestionsPanel } from "@/components/SuggestionsPanel";
import { TelemetryPanel } from "@/components/TelemetryPanel";
import { ToastViewport } from "@/components/ToastViewport";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { useAudio } from "@/hooks/useAudio";
import { useChat } from "@/hooks/useChat";
import { useMeetingClassifier } from "@/hooks/useMeetingClassifier";
import { useMeetingWrapUp } from "@/hooks/useMeetingWrapUp";
import { useRollingSummary } from "@/hooks/useRollingSummary";
import { useSalienceStore } from "@/hooks/useSalienceStore";
import { useSuggestionPreferences } from "@/hooks/useSuggestionPreferences";
import { useSuggestions } from "@/hooks/useSuggestions";
import { useToastQueue } from "@/hooks/useToastQueue";
import type { RollingSummary, SalientMoment, Suggestion, SuggestionMeta } from "@/lib/types";

type MobileTab = "transcript" | "suggestions" | "chat";
type TranscriptJumpTarget = {
  requestId: number;
  timestamp: string;
};

const DISPLAY_INTERVAL_MS = 30_000;
const AVG_GENERATION_MS = 15_000;
const PRE_FIRE_OFFSET_MS = AVG_GENERATION_MS;
const WARMUP_MS = DISPLAY_INTERVAL_MS - PRE_FIRE_OFFSET_MS;

const formatRecordingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingMinutes = minutes % 60;
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")}`;
};

export default function HomePage() {
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
  const [, setIsWaitingForSpeech] = useState(false);
  const { pushToast, removeToast, toasts } = useToastQueue();
  const {
    clearPins,
    isMuted,
    isPinned,
    mutedTypes,
    pinnedIds,
    pinnedSuggestions,
    resetMutedTypes,
    toggleMuteType,
    togglePin,
  } = useSuggestionPreferences();
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
  } = useAudio();
  const [isRefreshingTranscript, setIsRefreshingTranscript] = useState(false);
  const [nextAutoRefreshAt, setNextAutoRefreshAt] = useState<number | null>(null);
  const [suggestionsCountdown, setSuggestionsCountdown] = useState<number | null>(null);
  const {
    cancelSuggestions,
    clearSuggestions,
    error: suggestionsError,
    generateSuggestions,
    isLoading: isSuggestionsLoading,
    lastGroundingDebug,
    lastPipelineDebug,
    skipState,
    streamingBatches,
    suggestions,
  } = useSuggestions({
    pauseWhileChatInflight: () => isChatLoadingRef.current,
  });
  const {
    addSuggestionAsMessage,
    error: chatError,
    isLoading: isChatLoading,
    messages,
    retryMessage,
    sendMessage,
  } = useChat();
  const { resetSummary, rollingSummary } = useRollingSummary({
    enabled: isRecording,
    transcript: committedTranscript,
  });
  const {
    wrapUp,
    isGenerating: isGeneratingWrapUp,
    generate: generateWrapUp,
    reset: resetWrapUp,
  } = useMeetingWrapUp();
  const { classifiedType } = useMeetingClassifier({
    enabled: isRecording,
    recordingDurationMs,
    transcript: committedTranscript,
  });
  const { moments: salientMoments, reset: resetSalience } = useSalienceStore({
    chunks: committedTranscript,
    isRecording,
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
      setNextAutoRefreshAt(null);
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
    let cycleIndex = 1;
    const startedAt = Date.now();
    setNextAutoRefreshAt(startedAt + DISPLAY_INTERVAL_MS);
    const warmupId = window.setTimeout(() => {
      maybeGenerateSuggestions();
      cycleIndex += 1;
      setNextAutoRefreshAt(startedAt + DISPLAY_INTERVAL_MS * cycleIndex);
      intervalId = window.setInterval(() => {
        maybeGenerateSuggestions();
        cycleIndex += 1;
        setNextAutoRefreshAt(startedAt + DISPLAY_INTERVAL_MS * cycleIndex);
      }, DISPLAY_INTERVAL_MS);
    }, WARMUP_MS);

    return () => {
      window.clearTimeout(warmupId);
      setNextAutoRefreshAt(null);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [cancelSuggestions, isRecording]);

  useEffect(() => {
    if (!isRecording || nextAutoRefreshAt === null) {
      setSuggestionsCountdown(null);
      return;
    }

    const updateCountdown = () => {
      setSuggestionsCountdown(Math.max(0, Math.ceil((nextAutoRefreshAt - Date.now()) / 1000)));
    };

    updateCountdown();
    const timerId = window.setInterval(updateCountdown, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isRecording, nextAutoRefreshAt]);

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

  const handleStartRecording = useCallback(async () => {
    setActiveMobileTab("transcript");
    resetWrapUp();
    await startRecording();
  }, [resetWrapUp, startRecording]);

  const handleStopRecording = useCallback(() => {
    stopRecording();
    void generateWrapUp({
      full_transcript: committedTranscript.map((chunk) => chunk.text).join("\n"),
      rolling_summary: rollingSummaryRef.current,
      salient_memory: salientMemoryRef.current,
      meeting_type: latestSuggestionMetaRef.current?.meeting_type,
    });
  }, [committedTranscript, generateWrapUp, stopRecording]);

  const handleClearTranscript = useCallback(() => {
    clearTranscript();
    clearSuggestions();
    resetSummary();
    resetSalience();
    resetWrapUp();
    clearPins();
    resetMutedTypes();
    lastGeneratedSignatureRef.current = "";
  }, [
    clearPins,
    clearSuggestions,
    clearTranscript,
    resetMutedTypes,
    resetSalience,
    resetSummary,
    resetWrapUp,
  ]);

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
      message: error,
      tone: "error",
      title: "Microphone issue",
    });
  }, [error, pushToast]);

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
        ? undefined
        : {
            label: "Retry",
            onAction: handleManualRefresh,
          },
      message: suggestionsError,
      tone: "error",
      title: "Suggestions failed",
    });
  }, [handleManualRefresh, pushToast, suggestionsError]);

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
        ? undefined
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
  }, [chatError, lastRetryableAssistantId, pushToast, retryMessage, transcript]);

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
        ? undefined
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
  }, [handleManualRefresh, pushToast, transcriptionNotice]);

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
    { id: "transcript" as const, label: "Transcript" },
    { id: "suggestions" as const, label: "Live Suggestions" },
    { id: "chat" as const, label: "Chat" },
  ];
  const handleJumpToTimestamp = useCallback((timestamp: string) => {
    setActiveMobileTab("transcript");
    setTranscriptJumpTarget({
      timestamp,
      requestId: Date.now(),
    });
  }, []);

  const totalSuggestionCount = useMemo(
    () => suggestions.reduce((total, batch) => total + batch.suggestions.length, 0),
    [suggestions],
  );
  const suggestionsHeaderBadge = `${totalSuggestionCount} ${totalSuggestionCount === 1 ? "card" : "cards"}`;
  const resolveSuggestionTimestamp = useCallback(
    (suggestion: Suggestion) => {
      const quote = suggestion.evidence_quote.trim().toLowerCase();

      if (!quote || quote === "(no quote captured)") {
        return null;
      }

      const matchingChunk = transcript.find((chunk) => chunk.text.toLowerCase().includes(quote));

      return matchingChunk ? matchingChunk.timestamp.toTimeString().slice(0, 8) : null;
    },
    [transcript],
  );

  return (
    <>
      <ToastViewport onDismiss={removeToast} toasts={toasts} />

      <main className="flex h-screen w-full flex-col overflow-hidden">
        <header className="app-header">
          <Link aria-label="TwinMind home" className="header-logo" href="/">
            <span className="logo-mark">T</span>
            <span className="logo-name">
              Twin<span>Mind</span>
            </span>
          </Link>

          <div className="header-right">
            <div aria-live="polite" className={`status-pill ${isRecording ? "" : "idle"}`}>
              <span aria-hidden="true" className="status-dot" />
              {isRecording ? "Live Session" : "Idle"}
            </div>
            <span className="session-time">{formatRecordingDuration(recordingDurationMs)}</span>
            <button
              aria-label="Open keyboard shortcuts help"
              className="header-icon-btn"
              title="Help"
              type="button"
              onClick={() => setIsHelpOpen(true)}
            >
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.9"
                viewBox="0 0 24 24"
              >
                <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 3-3 3" />
                <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <ExportButton
              buttonId="export-session-button"
              buttonClassName="header-icon-btn"
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
        </header>

        <nav
          aria-label="Mobile workspace tabs"
          className="tab-scroller mobile-tabs"
        >
          {mobileTabs.map((tab) => (
            <button
              key={tab.id}
              aria-pressed={activeMobileTab === tab.id}
              className={`mobile-tab ${activeMobileTab === tab.id ? "active" : ""}`}
              type="button"
              onClick={() => setActiveMobileTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <section className="hidden md:grid" id="cols">
          <div className="workspace-col">
            <div className="col-header">
              <span className="col-title">Transcript</span>
              <div className="col-header-right">
                <button className="clear-link-btn" type="button" onClick={handleClearTranscript}>
                  Clear
                </button>
                <span className={`col-badge ${isRecording ? "live" : ""}`}>
                  {isRecording ? (
                    <>
                      <span className="status-dot" />
                      Live
                    </>
                  ) : (
                    "Idle"
                  )}
                </span>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="px-4 pt-4">
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
              </div>
              <TranscriptPanel
                chunks={transcript}
                error={error}
                isRecording={isRecording}
                isSpeaking={isSpeaking}
                isTranscribing={isTranscribing}
                jumpTarget={transcriptJumpTarget}
              />
            </div>
          </div>

          <div className="workspace-col">
            <div className="col-header">
              <span className="col-title">Live Suggestions</span>
              <span className="col-badge">{suggestionsHeaderBadge}</span>
            </div>
            <SuggestionsPanel
              countdownSeconds={suggestionsCountdown}
              error={suggestionsError}
              isGeneratingWrapUp={isGeneratingWrapUp}
              isLoading={isSuggestionsLoading}
              isRecording={isRecording}
              isRefreshingTranscript={isRefreshingTranscript}
              isMuted={isMuted}
              isPinned={isPinned}
              mutedTypes={mutedTypes}
              onCopySuggestion={(suggestion) => {
                void handleCopySuggestion(suggestion);
              }}
              onDismissSuggestion={handleDismissSuggestion}
              onJumpToTimestamp={handleJumpToTimestamp}
              onNewSession={handleClearTranscript}
              onRefresh={handleManualRefresh}
              onSuggestionSelected={(suggestion, meta) => {
                void addSuggestionAsMessage(
                  suggestion,
                  committedTranscript,
                  buildChatContextOptions(meta),
                );
              }}
              pinnedIds={pinnedIds}
              pinnedSuggestions={pinnedSuggestions}
              resolveTimestampForSuggestion={resolveSuggestionTimestamp}
              skipState={skipState}
              streamingBatches={streamingBatches}
              suggestionBatches={suggestions}
              toggleMuteType={toggleMuteType}
              togglePin={togglePin}
              wrapUp={wrapUp}
            />
          </div>

          <div className="workspace-col">
            <div className="col-header">
              <span className="col-title">Deep Dive</span>
              <span className="col-badge">Session only</span>
            </div>
            <ChatPanel
              error={chatError}
              inputId="chat-input-desktop"
              isLoading={isChatLoading}
              messages={messages}
              onJumpToTimestamp={handleJumpToTimestamp}
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

        <section className="mobile-shell min-h-0 flex-1 flex-col">

          {activeMobileTab === "transcript" ? (
            <>
              <div className="col-header">
                <span className="col-title">Transcript</span>
                <div className="col-header-right">
                  <button className="clear-link-btn" type="button" onClick={handleClearTranscript}>
                    Clear
                  </button>
                  <span className={`col-badge ${isRecording ? "live" : ""}`}>
                    {isRecording ? (
                      <>
                        <span className="status-dot" />
                        Live
                      </>
                    ) : (
                      "Idle"
                    )}
                  </span>
                </div>
              </div>
              <div className="px-4 pt-4">
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
              </div>
              <TranscriptPanel
                chunks={transcript}
                error={error}
                isRecording={isRecording}
                isSpeaking={isSpeaking}
                isTranscribing={isTranscribing}
                jumpTarget={transcriptJumpTarget}
              />
            </>
          ) : null}

          {activeMobileTab === "suggestions" ? (
            <>
              <div className="col-header">
                <span className="col-title">Live Suggestions</span>
                <span className="col-badge">{suggestionsHeaderBadge}</span>
              </div>
              <SuggestionsPanel
                countdownSeconds={suggestionsCountdown}
                error={suggestionsError}
                isGeneratingWrapUp={isGeneratingWrapUp}
                isLoading={isSuggestionsLoading}
                isRecording={isRecording}
                isRefreshingTranscript={isRefreshingTranscript}
                isMuted={isMuted}
                isPinned={isPinned}
                mutedTypes={mutedTypes}
                onCopySuggestion={(suggestion) => {
                  void handleCopySuggestion(suggestion);
                }}
                onDismissSuggestion={handleDismissSuggestion}
                onJumpToTimestamp={handleJumpToTimestamp}
                onNewSession={handleClearTranscript}
                onRefresh={handleManualRefresh}
                onSuggestionSelected={(suggestion, meta) => {
                  void addSuggestionAsMessage(
                    suggestion,
                    committedTranscript,
                    buildChatContextOptions(meta),
                  );
                }}
                pinnedIds={pinnedIds}
                pinnedSuggestions={pinnedSuggestions}
                resolveTimestampForSuggestion={resolveSuggestionTimestamp}
                skipState={skipState}
                streamingBatches={streamingBatches}
                suggestionBatches={suggestions}
                toggleMuteType={toggleMuteType}
                togglePin={togglePin}
                wrapUp={wrapUp}
              />
            </>
          ) : null}

          {activeMobileTab === "chat" ? (
            <>
              <div className="col-header">
                <span className="col-title">Deep Dive</span>
                <span className="col-badge">Session only</span>
              </div>
              <ChatPanel
                error={chatError}
                inputId="chat-input-mobile"
                isLoading={isChatLoading}
                messages={messages}
                onJumpToTimestamp={handleJumpToTimestamp}
                onRetryMessage={(messageId, currentTranscript) => {
                  void retryMessage(messageId, currentTranscript, buildChatContextOptions());
                }}
                onSendMessage={(message, currentTranscript) => {
                  void sendMessage(message, currentTranscript, buildChatContextOptions());
                }}
                transcript={committedTranscript}
              />
            </>
          ) : null}
        </section>

        {isDebugEnabled ? (
          <>
            <SuggestionPipelineDebugPanel debug={lastPipelineDebug} grounding={lastGroundingDebug} />
            <TelemetryPanel grounding={lastGroundingDebug} />
          </>
        ) : null}
      </main>

      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </>
  );
}
