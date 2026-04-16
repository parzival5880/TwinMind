"use client";

import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { TranscriptChunk } from "@/lib/types";

type AddTranscriptChunkOptions = {
  speaker?: string;
  timestamp?: Date;
};

export function useTranscript() {
  const [transcript, setTranscript] = useState<TranscriptChunk[]>([]);

  const addChunk = (text: string, options?: AddTranscriptChunkOptions) => {
    const trimmedText = text.trim();

    if (!trimmedText) {
      return null;
    }

    const chunk: TranscriptChunk = {
      id: uuidv4(),
      timestamp: options?.timestamp ?? new Date(),
      text: trimmedText,
      speaker: options?.speaker,
    };

    setTranscript((currentTranscript) => [
      ...currentTranscript,
      chunk,
    ]);

    return chunk;
  };

  const clearTranscript = () => {
    setTranscript([]);
  };

  return {
    transcript,
    addChunk,
    clearTranscript,
  };
}
