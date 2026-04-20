"use client";

import { startTransition, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { TranscriptChunk } from "@/lib/types";

type AddTranscriptChunkOptions = {
  speaker?: string;
  timestamp?: Date;
};

export function useTranscript() {
  const [transcript, setTranscript] = useState<TranscriptChunk[]>([]);
  const [committedTranscript, setCommittedTranscript] = useState<TranscriptChunk[]>([]);

  const insertChunk = (chunk: TranscriptChunk) => {
    startTransition(() => {
      setTranscript((currentTranscript) => {
        const nextTranscript = currentTranscript.slice();
        const insertIndex = nextTranscript.findIndex(
          (currentChunk) => currentChunk.timestamp.getTime() > chunk.timestamp.getTime(),
        );

        if (insertIndex === -1) {
          nextTranscript.push(chunk);
        } else {
          nextTranscript.splice(insertIndex, 0, chunk);
        }

        return nextTranscript;
      });
    });

    return chunk;
  };

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

    return insertChunk(chunk);
  };

  const clearTranscript = () => {
    startTransition(() => {
      setTranscript([]);
      setCommittedTranscript([]);
    });
  };

  const replaceTranscript = (nextTranscript: TranscriptChunk[]) => {
    startTransition(() => {
      setTranscript(nextTranscript);
    });
  };

  const replaceCommittedTranscript = (nextTranscript: TranscriptChunk[]) => {
    startTransition(() => {
      setCommittedTranscript(nextTranscript);
    });
  };

  return {
    transcript,
    committedTranscript,
    addChunk,
    clearTranscript,
    insertChunk,
    replaceCommittedTranscript,
    replaceTranscript,
  };
}
