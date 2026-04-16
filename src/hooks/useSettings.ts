"use client";

import { useEffect, useState } from "react";
import {
  clearGroqClient,
  initializeGroqClient,
  testGroqApiKey,
  validateGroqApiKey,
} from "@/lib/groq-client";
import { DEFAULT_SETTINGS, PROMPT_MAX_LENGTH } from "@/lib/prompts";
import type { SettingsConfig, SettingsFieldErrors } from "@/lib/types";

const SETTINGS_STORAGE_KEY = "twinmind_settings";

export type SettingsFeedback =
  | {
      message: string;
      tone: "error" | "success";
    }
  | null;

type UseSettingsResult = {
  defaultSettings: SettingsConfig;
  feedback: SettingsFeedback;
  fieldErrors: SettingsFieldErrors;
  isSaving: boolean;
  isLoaded: boolean;
  resetSettings: () => void;
  settings: SettingsConfig;
  updateSettings: (settings: SettingsConfig) => Promise<boolean>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getDefaultSettings = (): SettingsConfig => ({
  ...DEFAULT_SETTINGS,
  groq_api_key: process.env.NEXT_PUBLIC_GROQ_API_KEY ?? DEFAULT_SETTINGS.groq_api_key,
});

const toPositiveInteger = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsedValue = Number.parseInt(value, 10);

    if (Number.isInteger(parsedValue) && parsedValue > 0) {
      return parsedValue;
    }
  }

  return fallback;
};

const normalizeSettingsConfig = (
  value: unknown,
  fallback: SettingsConfig = getDefaultSettings(),
): SettingsConfig => {
  if (!isRecord(value)) {
    return fallback;
  }

  return {
    groq_api_key:
      typeof value.groq_api_key === "string"
        ? value.groq_api_key.trim()
        : fallback.groq_api_key,
    live_suggestion_prompt:
      typeof value.live_suggestion_prompt === "string"
        ? value.live_suggestion_prompt
        : fallback.live_suggestion_prompt,
    detailed_answer_prompt:
      typeof value.detailed_answer_prompt === "string"
        ? value.detailed_answer_prompt
        : fallback.detailed_answer_prompt,
    chat_prompt: typeof value.chat_prompt === "string" ? value.chat_prompt : fallback.chat_prompt,
    context_window_suggestions: toPositiveInteger(
      value.context_window_suggestions,
      fallback.context_window_suggestions,
    ),
    context_window_answers: toPositiveInteger(
      value.context_window_answers,
      fallback.context_window_answers,
    ),
  };
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected settings error occurred.";

const hasValidationErrors = (errors: SettingsFieldErrors) => Object.keys(errors).length > 0;

const withDefaults = (
  value: Partial<SettingsConfig> | SettingsConfig,
  fallback: SettingsConfig = getDefaultSettings(),
): SettingsConfig => ({
  ...fallback,
  ...value,
});

const validateSettingsConfig = (settings: SettingsConfig): SettingsFieldErrors => {
  const fieldErrors: SettingsFieldErrors = {};

  try {
    validateGroqApiKey(settings.groq_api_key);
  } catch (error) {
    fieldErrors.groq_api_key = getErrorMessage(error);
  }

  if (!settings.live_suggestion_prompt.trim()) {
    fieldErrors.live_suggestion_prompt = "Live suggestions prompt cannot be empty.";
  } else if (settings.live_suggestion_prompt.length > PROMPT_MAX_LENGTH) {
    fieldErrors.live_suggestion_prompt = `Live suggestions prompt must stay under ${PROMPT_MAX_LENGTH} characters.`;
  }

  if (!settings.detailed_answer_prompt.trim()) {
    fieldErrors.detailed_answer_prompt = "Detailed answer prompt cannot be empty.";
  } else if (settings.detailed_answer_prompt.length > PROMPT_MAX_LENGTH) {
    fieldErrors.detailed_answer_prompt = `Detailed answer prompt must stay under ${PROMPT_MAX_LENGTH} characters.`;
  }

  if (!settings.chat_prompt.trim()) {
    fieldErrors.chat_prompt = "Chat prompt cannot be empty.";
  } else if (settings.chat_prompt.length > PROMPT_MAX_LENGTH) {
    fieldErrors.chat_prompt = `Chat prompt must stay under ${PROMPT_MAX_LENGTH} characters.`;
  }

  if (
    !Number.isInteger(settings.context_window_suggestions) ||
    settings.context_window_suggestions < 1
  ) {
    fieldErrors.context_window_suggestions =
      "Suggestions context window must be a positive whole number.";
  }

  if (
    !Number.isInteger(settings.context_window_answers) ||
    settings.context_window_answers < 1
  ) {
    fieldErrors.context_window_answers =
      "Answers context window must be a positive whole number.";
  }

  return fieldErrors;
};

export function useSettings(): UseSettingsResult {
  const [defaultSettings, setDefaultSettings] = useState<SettingsConfig>(() => getDefaultSettings());
  const [settings, setSettings] = useState<SettingsConfig>(() => getDefaultSettings());
  const [fieldErrors, setFieldErrors] = useState<SettingsFieldErrors>({});
  const [feedback, setFeedback] = useState<SettingsFeedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const defaultSettings = getDefaultSettings();
    setDefaultSettings(defaultSettings);
    const storedSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

    if (!storedSettings) {
      setSettings(defaultSettings);

      if (defaultSettings.groq_api_key) {
        try {
          initializeGroqClient(defaultSettings.groq_api_key);
        } catch {
          clearGroqClient();
        }
      } else {
        clearGroqClient();
      }

      setIsLoaded(true);

      return;
    }

    try {
      const parsedSettings = withDefaults(
        normalizeSettingsConfig(JSON.parse(storedSettings), defaultSettings),
        defaultSettings,
      );

      setSettings(parsedSettings);

      if (parsedSettings.groq_api_key) {
        try {
          initializeGroqClient(parsedSettings.groq_api_key);
        } catch (error) {
          clearGroqClient();
          setFieldErrors({ groq_api_key: getErrorMessage(error) });
          setFeedback({
            tone: "error",
            message: "Saved settings contain an invalid Groq API key. Update it before continuing.",
          });
        }
      } else {
        clearGroqClient();
      }
    } catch {
      window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
      clearGroqClient();
      setSettings(defaultSettings);
      setFeedback({
        tone: "error",
        message: "Saved settings could not be read. Defaults were restored instead.",
      });
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const updateSettings = async (nextSettings: SettingsConfig) => {
    const resolvedDefaults = getDefaultSettings();
    const normalizedSettings = withDefaults(
      normalizeSettingsConfig(nextSettings, resolvedDefaults),
      resolvedDefaults,
    );
    const validationErrors = validateSettingsConfig(normalizedSettings);

    if (hasValidationErrors(validationErrors)) {
      setFieldErrors(validationErrors);
      setFeedback({
        tone: "error",
        message: "Please correct the highlighted settings fields before saving.",
      });

      return false;
    }

    setIsSaving(true);
    setFeedback({
      tone: "success",
      message: "Validating Groq API key before saving settings…",
    });

    try {
      await testGroqApiKey(normalizedSettings.groq_api_key);
      initializeGroqClient(normalizedSettings.groq_api_key);
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizedSettings));
      setDefaultSettings(resolvedDefaults);
      setSettings(normalizedSettings);
      setFieldErrors({});
      setFeedback({ tone: "success", message: "API key validated and settings saved." });

      return true;
    } catch (error) {
      clearGroqClient();
      setFieldErrors({ groq_api_key: getErrorMessage(error) });
      setFeedback({ tone: "error", message: getErrorMessage(error) });

      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const resetSettings = () => {
    const defaultSettings = getDefaultSettings();

    if (defaultSettings.groq_api_key) {
      try {
        initializeGroqClient(defaultSettings.groq_api_key);
      } catch {
        clearGroqClient();
      }
    } else {
      clearGroqClient();
    }

    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    setDefaultSettings(defaultSettings);
    setSettings(defaultSettings);
    setFieldErrors({});
    setFeedback({
      tone: "success",
      message: "Defaults restored and saved settings were cleared from localStorage.",
    });
  };

  return {
    defaultSettings,
    feedback,
    fieldErrors,
    isSaving,
    isLoaded,
    resetSettings,
    settings,
    updateSettings,
  };
}
