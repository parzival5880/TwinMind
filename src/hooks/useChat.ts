"use client";

import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  ChatMessage,
  ChatResponse,
  Suggestion,
  TranscriptChunk,
} from "@/lib/types";

type UseChatOptions = {
  chatPromptTemplate?: string;
  contextWindow?: number;
  detailedAnswerPromptTemplate?: string;
  groqApiKey?: string;
};

type UseChatResult = {
  addSuggestionAsMessage: (
    suggestion: Suggestion,
    transcript: TranscriptChunk[],
  ) => Promise<void>;
  error: string | null;
  isLoading: boolean;
  messages: ChatMessage[];
  sendMessage: (message: string, transcript: TranscriptChunk[]) => Promise<void>;
};

const buildTranscriptString = (transcript: TranscriptChunk[]) =>
  transcript
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";

      return `[${chunk.timestamp.toISOString()}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

export function useChat({
  chatPromptTemplate,
  contextWindow,
  detailedAnswerPromptTemplate,
  groqApiKey,
}: UseChatOptions = {}): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessageWithPrompt = async (
    message: string,
    transcript: TranscriptChunk[],
    promptTemplate?: string,
  ) => {
    const trimmedMessage = message.trim();

    if (!trimmedMessage || isLoading) {
      return;
    }

    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: trimmedMessage,
      timestamp: new Date(),
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(groqApiKey ? { "x-groq-api-key": groqApiKey } : {}),
        },
        body: JSON.stringify({
          user_message: trimmedMessage,
          full_transcript: buildTranscriptString(transcript),
          chat_history: messages.concat(userMessage),
          context_window: contextWindow,
          prompt_template: promptTemplate,
        }),
      });

      const payload = (await response.json()) as ChatResponse;

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Failed to generate a detailed answer.");
      }

      const assistantMessage: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: payload.message,
        timestamp: new Date(payload.timestamp),
      };

      setMessages((currentMessages) => [...currentMessages, assistantMessage]);
    } catch {
      setError("Failed to generate a detailed answer.");
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async (message: string, transcript: TranscriptChunk[]) => {
    await sendMessageWithPrompt(message, transcript, chatPromptTemplate);
  };

  const addSuggestionAsMessage = async (
    suggestion: Suggestion,
    transcript: TranscriptChunk[],
  ) => {
    await sendMessageWithPrompt(
      suggestion.preview,
      transcript,
      detailedAnswerPromptTemplate ?? chatPromptTemplate,
    );
  };

  return {
    addSuggestionAsMessage,
    error,
    isLoading,
    messages,
    sendMessage,
  };
}
