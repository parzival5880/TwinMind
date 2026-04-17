"use client";

import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { v4 as uuidv4 } from "uuid";
import { startTelemetryMeasurement } from "@/lib/telemetry";
import type {
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  SerializedChatMessage,
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
  retryMessage: (messageId: string, transcript: TranscriptChunk[]) => Promise<void>;
  sendMessage: (message: string, transcript: TranscriptChunk[]) => Promise<void>;
};

type StreamRequestOptions = {
  appendUserMessage: boolean;
  assistantMessageId?: string;
  promptTemplate?: string;
};

const buildTranscriptString = (transcript: TranscriptChunk[]) =>
  transcript
    .map((chunk) => {
      const speakerLabel = chunk.speaker ? `${chunk.speaker}: ` : "";

      return `[${format(chunk.timestamp, "HH:mm")}] ${speakerLabel}${chunk.text}`;
    })
    .join("\n");

const serializeChatHistory = (messages: ChatMessage[]): SerializedChatMessage[] =>
  messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
  }));

const parseSseEvent = (rawEvent: string): string[] =>
  rawEvent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

const CHAT_FETCH_TIMEOUT_MS = 25_000;

export function useChat({
  chatPromptTemplate,
  contextWindow,
  detailedAnswerPromptTemplate,
  groqApiKey,
}: UseChatOptions = {}): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const sendMessageWithPrompt = async (
    message: string,
    transcript: TranscriptChunk[],
    {
      appendUserMessage,
      assistantMessageId,
      promptTemplate,
    }: StreamRequestOptions,
  ) => {
    const trimmedMessage = message.trim();

    if (!trimmedMessage || isLoading) {
      return;
    }

    const now = new Date();
    const userMessage: ChatMessage | null = appendUserMessage
      ? {
          id: uuidv4(),
          role: "user",
          content: trimmedMessage,
          timestamp: now,
        }
      : null;
    const resolvedAssistantMessageId = assistantMessageId ?? uuidv4();
    const assistantPlaceholder: ChatMessage = {
      id: resolvedAssistantMessageId,
      role: "assistant",
      content: "",
      timestamp: now,
      isStreaming: true,
      requestMessage: trimmedMessage,
      requestPromptTemplate: promptTemplate,
      streamError: false,
    };
    const baseHistoryMessages = appendUserMessage
      ? messagesRef.current
      : messagesRef.current.filter((currentMessage) => currentMessage.id !== resolvedAssistantMessageId);
    const nextHistoryMessages = appendUserMessage
      ? [...baseHistoryMessages, userMessage as ChatMessage]
      : baseHistoryMessages;

    if (appendUserMessage && userMessage) {
      setMessages((currentMessages) => [...currentMessages, userMessage, assistantPlaceholder]);
    } else {
      setMessages((currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === resolvedAssistantMessageId
            ? {
                ...currentMessage,
                content: "",
                errorMessage: undefined,
                isStreaming: true,
                requestMessage: trimmedMessage,
                requestPromptTemplate: promptTemplate,
                streamError: false,
                timestamp: now,
              }
            : currentMessage,
        ),
      );
    }

    setIsLoading(true);
    setError(null);

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    const abortTimeoutId = window.setTimeout(() => {
      abortController.abort();
    }, CHAT_FETCH_TIMEOUT_MS);
    abortControllerRef.current = abortController;

    try {
      const completeFirstTokenTelemetry = startTelemetryMeasurement("chat_first_token");
      const completeLastTokenTelemetry = startTelemetryMeasurement("chat_last_token");
      const response = await fetch("/api/chat", {
        signal: abortController.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(groqApiKey ? { "x-groq-api-key": groqApiKey } : {}),
        },
        body: JSON.stringify({
          user_message: trimmedMessage,
          full_transcript: buildTranscriptString(transcript),
          chat_history: serializeChatHistory(nextHistoryMessages),
          context_window: contextWindow,
          prompt_template: promptTemplate,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as ChatResponse;

        throw new Error(payload.error || "Failed to generate a detailed answer.");
      }

      if (!response.body) {
        throw new Error("The response stream was empty.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let didRecordFirstToken = false;
      let receivedDone = false;

      const appendToken = (token: string) => {
        if (!didRecordFirstToken) {
          didRecordFirstToken = true;
          completeFirstTokenTelemetry({
            source: appendUserMessage ? "new" : "retry",
          });
        }

        setMessages((currentMessages) =>
          currentMessages.map((currentMessage) =>
            currentMessage.id === resolvedAssistantMessageId
              ? {
                  ...currentMessage,
                  content: `${currentMessage.content}${token}`,
                }
              : currentMessage,
          ),
        );
      };

      const finalizeAssistantMessage = (streamErrorMessage?: string) => {
        setMessages((currentMessages) =>
          currentMessages.map((currentMessage) =>
            currentMessage.id === resolvedAssistantMessageId
              ? {
                  ...currentMessage,
                  errorMessage: streamErrorMessage,
                  isStreaming: false,
                  streamError: Boolean(streamErrorMessage),
                }
              : currentMessage,
          ),
        );
      };

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");

        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const dataLines = parseSseEvent(rawEvent);

          for (const dataLine of dataLines) {
            if (dataLine === "[DONE]") {
              receivedDone = true;
              completeLastTokenTelemetry({
                source: appendUserMessage ? "new" : "retry",
              });
              finalizeAssistantMessage();
              break;
            }

            const parsedEvent = JSON.parse(dataLine) as ChatStreamEvent;

            if ("error" in parsedEvent) {
              throw new Error(parsedEvent.error || "The response stream ended unexpectedly.");
            }

            appendToken(parsedEvent.token);
          }
        }
      }

      if (!receivedDone) {
        throw new Error("The response stream ended unexpectedly.");
      }

    } catch (caughtError) {
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to generate a detailed answer.";

      setMessages((currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === resolvedAssistantMessageId
            ? {
                ...currentMessage,
                errorMessage,
                isStreaming: false,
                streamError: true,
              }
            : currentMessage,
        ),
      );
      setError(errorMessage);
    } finally {
      window.clearTimeout(abortTimeoutId);
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  const sendMessage = async (message: string, transcript: TranscriptChunk[]) => {
    await sendMessageWithPrompt(message, transcript, {
      appendUserMessage: true,
      promptTemplate: chatPromptTemplate,
    });
  };

  const addSuggestionAsMessage = async (
    suggestion: Suggestion,
    transcript: TranscriptChunk[],
  ) => {
    await sendMessageWithPrompt(suggestion.preview, transcript, {
      appendUserMessage: true,
      promptTemplate: detailedAnswerPromptTemplate ?? chatPromptTemplate,
    });
  };

  const retryMessage = async (messageId: string, transcript: TranscriptChunk[]) => {
    const messageToRetry = messagesRef.current.find((message) => message.id === messageId);

    if (!messageToRetry?.requestMessage) {
      return;
    }

    await sendMessageWithPrompt(messageToRetry.requestMessage, transcript, {
      appendUserMessage: false,
      assistantMessageId: messageId,
      promptTemplate: messageToRetry.requestPromptTemplate,
    });
  };

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  return {
    addSuggestionAsMessage,
    error,
    isLoading,
    messages,
    retryMessage,
    sendMessage,
  };
}
