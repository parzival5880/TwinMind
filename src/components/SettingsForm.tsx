"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { SettingsFeedback } from "@/hooks/useSettings";
import { PROMPT_MAX_LENGTH } from "@/lib/prompts";
import type { SettingsConfig, SettingsFieldErrors } from "@/lib/types";

type SettingsFormProps = {
  defaultSettings: SettingsConfig;
  fieldErrors: SettingsFieldErrors;
  feedback: SettingsFeedback;
  isLoaded: boolean;
  isSaving: boolean;
  onReset: () => void;
  onSave: (settings: SettingsConfig) => Promise<boolean>;
  settings: SettingsConfig;
};

type SettingsFormValues = {
  groq_api_key: string;
  live_suggestion_prompt: string;
  detailed_answer_prompt: string;
  chat_prompt: string;
  context_window_suggestions: string;
  context_window_answers: string;
};

const toFormValues = (settings: SettingsConfig): SettingsFormValues => ({
  groq_api_key: settings.groq_api_key,
  live_suggestion_prompt: settings.live_suggestion_prompt,
  detailed_answer_prompt: settings.detailed_answer_prompt,
  chat_prompt: settings.chat_prompt,
  context_window_suggestions: String(settings.context_window_suggestions),
  context_window_answers: String(settings.context_window_answers),
});

const toSettingsConfig = (values: SettingsFormValues): SettingsConfig => ({
  groq_api_key: values.groq_api_key.trim(),
  live_suggestion_prompt: values.live_suggestion_prompt,
  detailed_answer_prompt: values.detailed_answer_prompt,
  chat_prompt: values.chat_prompt,
  context_window_suggestions: Number.parseInt(values.context_window_suggestions, 10),
  context_window_answers: Number.parseInt(values.context_window_answers, 10),
});

export function SettingsForm({
  defaultSettings,
  fieldErrors,
  feedback,
  isLoaded,
  isSaving,
  onReset,
  onSave,
  settings,
}: SettingsFormProps) {
  const [formValues, setFormValues] = useState<SettingsFormValues>(() => toFormValues(settings));
  const [showDefaults, setShowDefaults] = useState(false);
  const defaultFormValues = toFormValues(defaultSettings);

  useEffect(() => {
    setFormValues(toFormValues(settings));
  }, [settings]);

  const handleFieldChange = <Key extends keyof SettingsFormValues>(
    field: Key,
    value: SettingsFormValues[Key],
  ) => {
    setFormValues((currentValues) => ({
      ...currentValues,
      [field]: value,
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSave(toSettingsConfig(formValues));
  };

  const handleReset = () => {
    onReset();
  };

  const isFieldEdited = (field: keyof SettingsFormValues) => formValues[field] !== defaultFormValues[field];

  const getFieldClassName = (fieldError: string | undefined, isEdited: boolean) =>
    `w-full rounded-[1rem] border bg-white px-4 py-3 text-sm text-slate-900 outline-none transition ${
      fieldError
        ? "border-rose-400 focus:border-rose-500"
        : isEdited
          ? "border-amber-300 focus:border-cyan-500"
          : "border-slate-300 focus:border-cyan-500"
    }`;

  const renderEditedBadge = (field: keyof SettingsFormValues) =>
    isFieldEdited(field) ? (
      <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
        Edited
      </span>
    ) : null;

  const renderPromptCounter = (value: string) => (
    <p className="text-xs leading-5 text-slate-500">
      {value.length}/{PROMPT_MAX_LENGTH} characters
    </p>
  );

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-[1.5rem] bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            App Name
          </p>
          <p className="mt-2 text-sm text-slate-700">
            {process.env.NEXT_PUBLIC_APP_NAME ?? "TwinMind"}
          </p>
        </div>
        <div className="rounded-[1.5rem] bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Stored API Key
          </p>
          <p className="mt-2 text-sm text-slate-700">
            {settings.groq_api_key ? "Configured locally" : "Not saved yet"}
          </p>
        </div>
        <div className="rounded-[1.5rem] bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Persistence
          </p>
          <p className="mt-2 text-sm text-slate-700">Saved in localStorage as `twinmind_settings`</p>
        </div>
      </div>

      {feedback ? (
        <div
          aria-live={feedback.tone === "error" ? "assertive" : "polite"}
          className={`rounded-[1.5rem] border px-4 py-3 text-sm ${
            feedback.tone === "error"
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-slate-200 bg-white/80 px-4 py-3">
        <p className="text-sm text-slate-600">
          Review the hardcoded defaults before overriding prompt or context behavior.
        </p>
        <button
          aria-expanded={showDefaults}
          className="text-sm font-semibold text-cyan-700 transition hover:text-cyan-900"
          type="button"
          onClick={() => setShowDefaults((currentValue) => !currentValue)}
        >
          {showDefaults ? "Hide Current Defaults" : "View Current Defaults"}
        </button>
      </div>

      {showDefaults ? (
        <section
          className="grid gap-4 rounded-[1.75rem] border border-slate-200 bg-slate-50/90 p-5 xl:grid-cols-2"
          id="current-defaults"
        >
          <div className="space-y-4">
            <div className="rounded-[1.25rem] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Live Suggestions Default
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-6 text-slate-700">
                {defaultSettings.live_suggestion_prompt}
              </pre>
            </div>
            <div className="rounded-[1.25rem] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Detailed Answer Default
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-6 text-slate-700">
                {defaultSettings.detailed_answer_prompt}
              </pre>
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-[1.25rem] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Chat Default
              </p>
              <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-6 text-slate-700">
                {defaultSettings.chat_prompt}
              </pre>
            </div>
            <div className="rounded-[1.25rem] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Context Windows
              </p>
              <dl className="mt-3 space-y-2 text-sm text-slate-700">
                <div className="flex items-center justify-between gap-4">
                  <dt>Suggestions</dt>
                  <dd>{defaultSettings.context_window_suggestions} tokens</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt>Answers</dt>
                  <dd>{defaultSettings.context_window_answers} tokens</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-4 rounded-[1.75rem] border border-slate-200 bg-white/85 p-5">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-slate-950">Groq Configuration</h3>
          <p className="text-sm leading-6 text-slate-600">
            Paste the Groq API key that should be used for transcript analysis and suggestion
            generation.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-semibold text-slate-800" htmlFor="groq-api-key">
              Groq API Key
            </label>
            {renderEditedBadge("groq_api_key")}
          </div>
          <input
            aria-describedby={fieldErrors.groq_api_key ? "groq-api-key-error" : "groq-api-key-help"}
            autoComplete="off"
            className={getFieldClassName(fieldErrors.groq_api_key, isFieldEdited("groq_api_key"))}
            id="groq-api-key"
            name="groq_api_key"
            spellCheck={false}
            type="password"
            value={formValues.groq_api_key}
            onChange={(event) => handleFieldChange("groq_api_key", event.target.value)}
          />
          <p className="text-xs leading-5 text-slate-500" id="groq-api-key-help">
            The key is stored only in your browser for this workspace and is never logged.
          </p>
          {fieldErrors.groq_api_key ? (
            <p className="text-sm text-rose-600" id="groq-api-key-error">
              {fieldErrors.groq_api_key}
            </p>
          ) : null}
        </div>
      </section>

      <section className="space-y-4 rounded-[1.75rem] border border-slate-200 bg-white/85 p-5">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-slate-950">Prompt Templates</h3>
          <p className="text-sm leading-6 text-slate-600">
            These prompts control live suggestions, detailed answers, and conversational chat
            responses.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-semibold text-slate-800" htmlFor="live-suggestions-prompt">
              Live Suggestions Prompt
            </label>
            <div className="flex items-center gap-2">
              {renderPromptCounter(formValues.live_suggestion_prompt)}
              {renderEditedBadge("live_suggestion_prompt")}
            </div>
          </div>
          <textarea
            aria-describedby={
              fieldErrors.live_suggestion_prompt
                ? "live-suggestions-prompt-error"
                : undefined
            }
            className={`min-h-56 ${getFieldClassName(
              fieldErrors.live_suggestion_prompt,
              isFieldEdited("live_suggestion_prompt"),
            )} leading-6`}
            id="live-suggestions-prompt"
            maxLength={PROMPT_MAX_LENGTH}
            name="live_suggestion_prompt"
            value={formValues.live_suggestion_prompt}
            onChange={(event) =>
              handleFieldChange("live_suggestion_prompt", event.target.value)
            }
          />
          {fieldErrors.live_suggestion_prompt ? (
            <p className="text-sm text-rose-600" id="live-suggestions-prompt-error">
              {fieldErrors.live_suggestion_prompt}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-semibold text-slate-800" htmlFor="detailed-answer-prompt">
                Detailed Answer Prompt
              </label>
              <div className="flex items-center gap-2">
                {renderPromptCounter(formValues.detailed_answer_prompt)}
                {renderEditedBadge("detailed_answer_prompt")}
              </div>
            </div>
            <textarea
              aria-describedby={
                fieldErrors.detailed_answer_prompt
                  ? "detailed-answer-prompt-error"
                  : undefined
              }
              className={`min-h-64 ${getFieldClassName(
                fieldErrors.detailed_answer_prompt,
                isFieldEdited("detailed_answer_prompt"),
              )} leading-6`}
              id="detailed-answer-prompt"
              maxLength={PROMPT_MAX_LENGTH}
              name="detailed_answer_prompt"
              value={formValues.detailed_answer_prompt}
              onChange={(event) =>
                handleFieldChange("detailed_answer_prompt", event.target.value)
              }
            />
            {fieldErrors.detailed_answer_prompt ? (
              <p className="text-sm text-rose-600" id="detailed-answer-prompt-error">
                {fieldErrors.detailed_answer_prompt}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-semibold text-slate-800" htmlFor="chat-prompt">
                Chat Prompt
              </label>
              <div className="flex items-center gap-2">
                {renderPromptCounter(formValues.chat_prompt)}
                {renderEditedBadge("chat_prompt")}
              </div>
            </div>
            <textarea
              aria-describedby={fieldErrors.chat_prompt ? "chat-prompt-error" : undefined}
              className={`min-h-64 ${getFieldClassName(
                fieldErrors.chat_prompt,
                isFieldEdited("chat_prompt"),
              )} leading-6`}
              id="chat-prompt"
              maxLength={PROMPT_MAX_LENGTH}
              name="chat_prompt"
              value={formValues.chat_prompt}
              onChange={(event) => handleFieldChange("chat_prompt", event.target.value)}
            />
            {fieldErrors.chat_prompt ? (
              <p className="text-sm text-rose-600" id="chat-prompt-error">
                {fieldErrors.chat_prompt}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-[1.75rem] border border-slate-200 bg-white/85 p-5">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-slate-950">Context Windows</h3>
          <p className="text-sm leading-6 text-slate-600">
            Define how much transcript context is considered for live suggestions and detailed
            answers.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-semibold text-slate-800" htmlFor="context-window-suggestions">
                Suggestions Context Window
              </label>
              {renderEditedBadge("context_window_suggestions")}
            </div>
            <input
              aria-describedby={
                fieldErrors.context_window_suggestions
                  ? "context-window-suggestions-error"
                  : "context-window-suggestions-help"
              }
              className={getFieldClassName(
                fieldErrors.context_window_suggestions,
                isFieldEdited("context_window_suggestions"),
              )}
              id="context-window-suggestions"
              inputMode="numeric"
              min="1"
              name="context_window_suggestions"
              step="1"
              type="number"
              value={formValues.context_window_suggestions}
              onChange={(event) =>
                handleFieldChange("context_window_suggestions", event.target.value)
              }
            />
            <p className="text-xs leading-5 text-slate-500" id="context-window-suggestions-help">
              Suggested starting point: 2000 tokens.
            </p>
            {fieldErrors.context_window_suggestions ? (
              <p className="text-sm text-rose-600" id="context-window-suggestions-error">
                {fieldErrors.context_window_suggestions}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-semibold text-slate-800" htmlFor="context-window-answers">
                Answers Context Window
              </label>
              {renderEditedBadge("context_window_answers")}
            </div>
            <input
              aria-describedby={
                fieldErrors.context_window_answers
                  ? "context-window-answers-error"
                  : "context-window-answers-help"
              }
              className={getFieldClassName(
                fieldErrors.context_window_answers,
                isFieldEdited("context_window_answers"),
              )}
              id="context-window-answers"
              inputMode="numeric"
              min="1"
              name="context_window_answers"
              step="1"
              type="number"
              value={formValues.context_window_answers}
              onChange={(event) =>
                handleFieldChange("context_window_answers", event.target.value)
              }
            />
            <p className="text-xs leading-5 text-slate-500" id="context-window-answers-help">
              Suggested starting point: 4000 tokens.
            </p>
            {fieldErrors.context_window_answers ? (
              <p className="text-sm text-rose-600" id="context-window-answers-error">
                {fieldErrors.context_window_answers}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <button
          className="rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isLoaded || isSaving}
          type="button"
          onClick={handleReset}
        >
          Reset to Defaults
        </button>
        <button
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isLoaded || isSaving}
          type="submit"
        >
          {isSaving ? "Validating API Key…" : "Save Settings"}
        </button>
      </div>
    </form>
  );
}
