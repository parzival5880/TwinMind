import type { SessionState } from "@/lib/types";

const APP_VERSION = "1.0.0";

type ExportedSession = {
  session: {
    app_version: string;
    exported_at: string;
    total_duration_seconds: number;
  };
  transcript: Array<{
    speaker: string;
    text: string;
    timestamp: string;
  }>;
  suggestion_batches: Array<{
    suggestions: Array<{
      full_content: string;
      preview: string;
      type: string;
    }>;
    timestamp: string;
  }>;
  chat_history: Array<{
    content: string;
    role: "user" | "assistant";
    timestamp: string;
  }>;
};

const toIsoString = (value: Date) => value.toISOString();

const collectSessionTimestamps = (session: SessionState) => [
  ...session.transcript.map((chunk) => chunk.timestamp.getTime()),
  ...session.suggestions.map((batch) => batch.timestamp.getTime()),
  ...session.chat.map((message) => message.timestamp.getTime()),
].filter((value) => Number.isFinite(value));

const getTotalDurationSeconds = (session: SessionState) => {
  const timestamps = collectSessionTimestamps(session);

  if (timestamps.length < 2) {
    return 0;
  }

  const sortedTimestamps = timestamps.slice().sort((left, right) => left - right);
  const lastTimestamp = sortedTimestamps[sortedTimestamps.length - 1];

  return Math.max(0, Math.round((lastTimestamp - sortedTimestamps[0]) / 1000));
};

const buildExportedSession = (session: SessionState): ExportedSession => ({
  session: {
    app_version: APP_VERSION,
    exported_at: new Date().toISOString(),
    total_duration_seconds: getTotalDurationSeconds(session),
  },
  transcript: session.transcript.map((chunk) => ({
    timestamp: toIsoString(chunk.timestamp),
    text: chunk.text,
    speaker: chunk.speaker ?? "unknown",
  })),
  suggestion_batches: session.suggestions.map((batch) => ({
    timestamp: toIsoString(batch.timestamp),
    suggestions: batch.suggestions.map((suggestion) => ({
      type: suggestion.type,
      preview: suggestion.preview,
      full_content: suggestion.full_content,
    })),
  })),
  chat_history: session.chat.map((message) => ({
    timestamp: toIsoString(message.timestamp),
    role: message.role,
    content: message.content,
  })),
});

export const exportSessionAsJSON = (session: SessionState): string =>
  JSON.stringify(buildExportedSession(session), null, 2);

export const exportSessionAsText = (session: SessionState): string => {
  const exportedSession = buildExportedSession(session);

  const transcriptSection =
    exportedSession.transcript.length > 0
      ? exportedSession.transcript
          .map(
            (chunk) =>
              `- ${chunk.timestamp} | ${chunk.speaker}\n  ${chunk.text}`,
          )
          .join("\n")
      : "No transcript captured.";

  const suggestionsSection =
    exportedSession.suggestion_batches.length > 0
      ? exportedSession.suggestion_batches
          .map((batch, batchIndex) => {
            const batchSuggestions = batch.suggestions
              .map(
                (suggestion, suggestionIndex) =>
                  `${suggestionIndex + 1}. [${suggestion.type}] ${suggestion.preview}\n${suggestion.full_content}`,
              )
              .join("\n\n");

            return `Batch ${batchIndex + 1} | ${batch.timestamp}\n${batchSuggestions}`;
          })
          .join("\n\n")
      : "No suggestion batches generated.";

  const chatSection =
    exportedSession.chat_history.length > 0
      ? exportedSession.chat_history
          .map(
            (message) =>
              `- ${message.timestamp} | ${message.role.toUpperCase()}\n  ${message.content}`,
          )
          .join("\n")
      : "No chat history recorded.";

  return `TwinMind Session Export

Exported At: ${exportedSession.session.exported_at}
App Version: ${exportedSession.session.app_version}
Total Duration Seconds: ${exportedSession.session.total_duration_seconds}

=== Transcript ===
${transcriptSection}

=== Suggestion Batches ===
${suggestionsSection}

=== Chat History ===
${chatSection}
`;
};

export const downloadFile = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchorElement = document.createElement("a");

  anchorElement.href = objectUrl;
  anchorElement.download = filename;
  anchorElement.click();

  URL.revokeObjectURL(objectUrl);
};
