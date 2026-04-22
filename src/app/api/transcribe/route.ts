import OpenAI from "openai";
import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import {
  APIKeyError,
  TimeoutError,
  TranscriptionError,
  initializeGroqClient,
  transcribeAudio,
  validateGroqApiKey,
} from "@/lib/groq-client";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import type { TranscribeResponse } from "@/lib/types";

export const runtime = "edge";

const buildResponse = (
  response: Omit<TranscribeResponse, "timestamp"> & { timestamp?: string },
) => ({
  ...response,
  timestamp: response.timestamp ?? new Date().toISOString(),
});

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return NextResponse.json(
      buildResponse({
        error: "Audio data is required.",
        success: false,
        text: "",
        timestamp,
      }),
      { status: 400 },
    );
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      buildResponse({
        error: "Audio data is required.",
        success: false,
        text: "",
        timestamp,
      }),
      { status: 400 },
    );
  }

  const audioValue = formData.get("audio");
  const previousTailValue = formData.get("previous_tail");
  const promptValue = formData.get("prompt");

  if (!(audioValue instanceof Blob) || audioValue.size === 0) {
    return NextResponse.json(
      buildResponse({
        error: "Audio data is required.",
        success: false,
        text: "",
        timestamp,
      }),
      { status: 400 },
    );
  }

  try {
    const serverGroqKey = getServerGroqKey();

    if (!serverGroqKey) {
      return NextResponse.json(
        buildResponse({
          error: SERVER_GROQ_KEY_MISSING_MESSAGE,
          success: false,
          text: "",
          timestamp,
        }),
        { status: 500 },
      );
    }

    const resolvedApiKey = validateGroqApiKey(serverGroqKey);
    const previousTail =
      typeof previousTailValue === "string" && previousTailValue.trim()
        ? previousTailValue.trim().slice(-240)
        : typeof promptValue === "string" && promptValue.trim()
          ? promptValue.trim().slice(-240)
          : undefined;

    initializeGroqClient(resolvedApiKey);

    const result = await transcribeAudio(audioValue, {
      prompt: previousTail,
    });

    return NextResponse.json(
      buildResponse({
        success: true,
        text: result.text,
        startMs: result.startMs,
        endMs: result.endMs,
        timestamp,
      }),
    );
  } catch (error) {
    if (error instanceof APIKeyError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          success: false,
          text: "",
          timestamp,
        }),
        { status: 401 },
      );
    }

    if (error instanceof TimeoutError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          success: false,
          text: "",
          timestamp,
        }),
        { status: 504 },
      );
    }

    if (error instanceof OpenAI.APIError || error instanceof Groq.APIError) {
      if (error.status === 401) {
        return NextResponse.json(
          buildResponse({
            error: "Invalid API key",
            success: false,
            text: "",
            timestamp,
          }),
          { status: 401 },
        );
      }

      if (error.status === 429) {
        return NextResponse.json(
          buildResponse({
            error: "Rate limit hit",
            success: false,
            text: "",
            timestamp,
          }),
          { status: 429 },
        );
      }

      if (error.status === 408 || error.name === "APITimeoutError") {
        return NextResponse.json(
          buildResponse({
            error: "Request timeout",
            success: false,
            text: "",
            timestamp,
          }),
          { status: 504 },
        );
      }
    }

    const errorMessage =
      error instanceof TranscriptionError
        ? error.message
        : "Groq transcription failed. Try again in a moment.";

    return NextResponse.json(
      buildResponse({
        error: errorMessage,
        success: false,
        text: "",
        timestamp,
      }),
      { status: 500 },
    );
  }
}
