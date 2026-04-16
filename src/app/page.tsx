"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioRecorder } from "@/components/AudioRecorder";
import { ChatPanel } from "@/components/ChatPanel";
import { ExportButton } from "@/components/ExportButton";
import { SettingsModal } from "@/components/SettingsModal";
import { SuggestionsPanel } from "@/components/SuggestionsPanel";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { useAudio } from "@/hooks/useAudio";
import { useChat } from "@/hooks/useChat";
import { useSettings } from "@/hooks/useSettings";
import { useSuggestions } from "@/hooks/useSuggestions";

type MobileTab = "transcript" | "suggestions" | "chat";

const formatRecordingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
};

export default function HomePage() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>("transcript");
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
    error,
    isRecording,
    recordingDurationMs,
    startRecording,
    stopRecording,
    transcriptionNotice,
    transcript,
  } = useAudio({
    groqApiKey: settings.groq_api_key,
  });
  const {
    error: suggestionsError,
    generateSuggestions,
    isLoading: isSuggestionsLoading,
    suggestions,
  } = useSuggestions({
    contextWindow: settings.context_window_suggestions,
    groqApiKey: settings.groq_api_key,
    promptTemplate: settings.live_suggestion_prompt,
  });
  const {
    addSuggestionAsMessage,
    error: chatError,
    isLoading: isChatLoading,
    messages,
    sendMessage,
  } = useChat({
    chatPromptTemplate: settings.chat_prompt,
    contextWindow: settings.context_window_answers,
    detailedAnswerPromptTemplate: settings.detailed_answer_prompt,
    groqApiKey: settings.groq_api_key,
  });
  const transcriptSignature = useMemo(
    () => transcript.map((chunk) => `${chunk.timestamp.toISOString()}::${chunk.text}`).join("\n"),
    [transcript],
  );
  const lastGeneratedSignatureRef = useRef("");
  const transcriptSignatureRef = useRef(transcriptSignature);
  const isRecordingRef = useRef(isRecording);
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
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const handleGenerateSuggestions = useCallback(async () => {
    const batch = await generateSuggestions(transcript);

    if (batch) {
      lastGeneratedSignatureRef.current = transcriptSignature;
    }
  }, [generateSuggestions, transcript, transcriptSignature]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!isRecordingRef.current) {
        return;
      }

      if (
        transcriptSignatureRef.current.length === 0 ||
        transcriptSignatureRef.current === lastGeneratedSignatureRef.current
      ) {
        return;
      }

      void handleGenerateSuggestions();
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [handleGenerateSuggestions, isRecording]);

  const handleStartRecording = useCallback(async () => {
    setActiveMobileTab("transcript");
    await startRecording();
  }, [startRecording]);

  const handleStopRecording = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  const mobileTabs = [
    { id: "transcript" as const, label: `Transcript (${transcript.length})` },
    { id: "suggestions" as const, label: `Suggestions (${suggestions.length})` },
    { id: "chat" as const, label: `Chat (${messages.length})` },
  ];

  return (
    <>
      <main className="mx-auto flex min-h-screen w-full max-w-[1920px] flex-col px-3 py-3 sm:px-4 sm:py-4 lg:px-6 lg:py-6">
        <section className="soft-panel mb-4 rounded-[2rem] px-4 py-4 sm:px-6">
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
                    isRecording ? "animate-pulse bg-rose-500 shadow-[0_0_0_8px_rgba(244,63,94,0.14)]" : "bg-slate-300"
                  }`}
                />
                <div className="text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Recording Status
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {isRecording
                      ? `Recording ${formatRecordingDuration(recordingDurationMs)}`
                      : "Not Recording"}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                aria-label="Open settings modal"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-slate-950 hover:text-slate-950"
                type="button"
                onClick={() => setIsSettingsOpen(true)}
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
              <ExportButton className="items-stretch" session={sessionState} />
            </div>
          </div>
        </section>

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
              recordingDurationMs={recordingDurationMs}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
              transcriptionNotice={transcriptionNotice}
            />
            <TranscriptPanel chunks={transcript} onClear={clearTranscript} />
          </div>

          <div className="min-h-0 md:col-start-2 md:border-l md:border-slate-200 md:pl-6 xl:border-l xl:border-r xl:border-slate-200 xl:px-6">
            <SuggestionsPanel
              error={suggestionsError}
              isLoading={isSuggestionsLoading}
              onRefresh={() => {
                void handleGenerateSuggestions();
              }}
              onSuggestionSelected={(suggestion) => {
                void addSuggestionAsMessage(suggestion, transcript);
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
              onSendMessage={sendMessage}
              transcript={transcript}
            />
          </div>
        </section>

        <section className="flex flex-1 flex-col gap-4 md:hidden">
          <AudioRecorder
            error={error}
            isRecording={isRecording}
            recordingDurationMs={recordingDurationMs}
            onStartRecording={handleStartRecording}
            onStopRecording={handleStopRecording}
            transcriptionNotice={transcriptionNotice}
          />

          {activeMobileTab === "transcript" ? (
            <TranscriptPanel chunks={transcript} onClear={clearTranscript} />
          ) : null}

          {activeMobileTab === "suggestions" ? (
            <SuggestionsPanel
              error={suggestionsError}
              isLoading={isSuggestionsLoading}
              onRefresh={() => {
                void handleGenerateSuggestions();
              }}
              onSuggestionSelected={(suggestion) => {
                void addSuggestionAsMessage(suggestion, transcript);
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
              onSendMessage={sendMessage}
              transcript={transcript}
            />
          ) : null}
        </section>
      </main>

      <SettingsModal
        defaultSettings={defaultSettings}
        feedback={feedback}
        fieldErrors={fieldErrors}
        isOpen={isSettingsOpen}
        isLoaded={isLoaded}
        isSaving={isSaving}
        onClose={() => setIsSettingsOpen(false)}
        onResetSettings={resetSettings}
        onSaveSettings={updateSettings}
        settings={settings}
      />
    </>
  );
}
