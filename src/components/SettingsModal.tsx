"use client";

import { useEffect } from "react";
import { SettingsForm } from "@/components/SettingsForm";
import type { SettingsFeedback } from "@/hooks/useSettings";
import type { SettingsConfig, SettingsFieldErrors } from "@/lib/types";

type SettingsModalProps = {
  defaultSettings: SettingsConfig;
  fieldErrors: SettingsFieldErrors;
  feedback: SettingsFeedback;
  isOpen: boolean;
  isLoaded: boolean;
  isSaving: boolean;
  onClose: () => void;
  onResetSettings: () => void;
  onSaveSettings: (settings: SettingsConfig) => Promise<boolean>;
  settings: SettingsConfig;
};

export function SettingsModal({
  defaultSettings,
  fieldErrors,
  feedback,
  isOpen,
  isLoaded,
  isSaving,
  onClose,
  onResetSettings,
  onSaveSettings,
  settings,
}: SettingsModalProps) {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-4 backdrop-blur-sm sm:py-8"
      onClick={onClose}
    >
      <div
        aria-labelledby="settings-modal-title"
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-[2rem] border border-white/40 bg-[rgba(255,255,255,0.96)] p-6 shadow-[0_30px_80px_rgba(15,23,42,0.2)]"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
              Settings
            </p>
            <h2
              className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
              id="settings-modal-title"
            >
              Copilot prompt configuration
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Save your Groq key, tune the live prompts, and adjust the transcript context windows
              used for suggestions and answers.
            </p>
          </div>
          <button
            aria-label="Close settings"
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="panel-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <SettingsForm
            defaultSettings={defaultSettings}
            fieldErrors={fieldErrors}
            feedback={feedback}
            isLoaded={isLoaded}
            isSaving={isSaving}
            onReset={onResetSettings}
            onSave={onSaveSettings}
            settings={settings}
          />
        </div>
      </div>
    </div>
  );
}
