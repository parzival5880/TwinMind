#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const DEFAULT_BASE_URL = process.env.TWINMIND_BASE_URL ?? "http://localhost:3000";
const DEFAULT_CONTEXT_WINDOWS = {
  suggestions: 2000,
  answers: 4000,
};
const MAX_RETRIES = 4;

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const getRetryDelayMs = (message, attempt) => {
  const retryMatch = message.match(/try again in ([0-9.]+)s/i);

  if (retryMatch) {
    return Math.ceil(Number.parseFloat(retryMatch[1]) * 1000) + 250;
  }

  return (attempt + 1) * 5000;
};

const salesCallChunks = [
  "Ava: We are comparing vendors and need clarity on pricing tiers for teams of fifty and two hundred users.",
  "Jordan: Our main concern is whether premium support is included or priced separately.",
  "Ava: Security review is also part of procurement, especially SSO, audit logging, and data retention policies.",
  "Jordan: We need to know if onboarding is self-serve or if there is a dedicated customer success manager.",
  "Ava: The buyer will ask whether usage-based overages are predictable month to month.",
  "Jordan: We also need a quick answer on implementation time and migration support from the current tool.",
];

const technicalDiscussionChunks = [
  "Mina: The ingestion service keeps timing out when the queue spikes beyond ten thousand jobs.",
  "Raj: The current architecture retries too aggressively and saturates Redis before workers can catch up.",
  "Mina: We may need to separate synchronous request handling from asynchronous processing and add circuit breakers.",
  "Raj: Observability is also weak because traces stop once the job leaves the API gateway.",
  "Mina: Another issue is duplicate events from webhook delivery, which complicates idempotency guarantees.",
  "Raj: We need to decide whether to fix this in application logic or with a message broker that supports deduplication.",
];

const standupChunks = [
  "Lena: Yesterday I finished the dashboard filters and today I am starting QA fixes for mobile layout issues.",
  "Chris: I am blocked on an API contract mismatch with the analytics endpoint and need backend help.",
  "Nora: I wrapped up the onboarding email copy and will review the release checklist this afternoon.",
  "Chris: If backend confirms the response shape by noon, I can still make the sprint demo build.",
];

const multipleSpeakerChunks = [
  "Sam: Marketing wants a launch date by next Friday, but only if support has the FAQ ready.",
  "Priya: We can draft the FAQ, though billing edge cases are still being clarified with finance.",
  "Miguel: Sorry, to jump in, engineering also needs a decision on feature flags before we can stage rollout.",
  "Sam: Right, and sales is already asking whether early access customers get grandfathered pricing.",
  "Priya: Hold on, support also needs escalation paths documented because enterprise customers will ask on day one.",
  "Miguel: If we do not lock the scope today, QA will lose the regression window.",
];

const shortSessionChunks = [
  "Taylor: Quick sync, the client only wants confirmation that the invoice export is landing this sprint.",
  "Robin: Yes, but they also asked whether CSV and PDF formats both ship in the first release.",
];

const buildLongSessionChunks = () => {
  const topics = [
    "roadmap sequencing",
    "customer migration",
    "pricing sensitivity",
    "support coverage",
    "debugging alert noise",
    "API stability",
    "release risk",
    "integration dependencies",
  ];

  return Array.from({ length: 36 }, (_, index) => {
    const speaker = ["Alex", "Morgan", "Casey", "Rin"][index % 4];
    const topic = topics[index % topics.length];
    const sentence =
      index % 3 === 0
        ? `We should resolve ${topic} before launch because it affects downstream planning.`
        : index % 3 === 1
          ? `The current decision on ${topic} is still fuzzy, and stakeholders will probably ask follow-up questions.`
          : `Let's document next steps for ${topic}, owner assignments, and any unresolved dependencies.`;

    return `${speaker}: ${sentence}`;
  });
};

const scenarios = [
  {
    id: "sales-call",
    label: "Sales Call",
    keywords: ["pricing", "support", "security", "onboarding", "migration"],
    transcriptChunks: salesCallChunks,
  },
  {
    id: "technical-discussion",
    label: "Technical Discussion",
    keywords: ["architecture", "timeout", "retry", "queue", "idempotency"],
    transcriptChunks: technicalDiscussionChunks,
  },
  {
    id: "casual-standup",
    label: "Casual Standup",
    keywords: ["blocker", "today", "yesterday", "sprint", "demo"],
    transcriptChunks: standupChunks,
  },
  {
    id: "multiple-speakers",
    label: "Multiple Speakers",
    keywords: ["launch", "support", "pricing", "scope", "QA"],
    transcriptChunks: multipleSpeakerChunks,
  },
  {
    id: "short-session",
    label: "Short Session",
    keywords: ["invoice", "CSV", "PDF", "sprint"],
    transcriptChunks: shortSessionChunks,
  },
  {
    id: "long-session",
    label: "Long Session",
    keywords: ["roadmap", "pricing", "support", "dependencies", "launch"],
    transcriptChunks: buildLongSessionChunks(),
  },
];

const performanceChecks = {
  manyChatMessages: {
    transcriptChunks: technicalDiscussionChunks.concat(buildLongSessionChunks().slice(0, 10)),
    question: "Summarize the key architecture risks and propose the next two implementation steps.",
    chatHistory: Array.from({ length: 30 }, (_, index) => ({
      id: `history-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content:
        index % 2 === 0
          ? `Follow-up question ${index + 1} about operational risk and rollout planning.`
          : `Assistant response ${index + 1} covering tradeoffs, blockers, and mitigation ideas.`,
      timestamp: new Date(Date.UTC(2026, 3, 16, 15, Math.floor(index / 2), index % 60)).toISOString(),
    })),
  },
};

const createTranscriptText = (chunks) =>
  chunks
    .map((chunk, index) => {
      const timestamp = new Date(Date.UTC(2026, 3, 16, 15, Math.floor(index / 2), (index * 7) % 60)).toISOString();

      return `[${timestamp}] ${chunk}`;
    })
    .join("\n");

const buildSuggestionFingerprint = (suggestion) =>
  `${suggestion.type}::${suggestion.preview.trim().toLowerCase()}::${suggestion.full_content
    .trim()
    .toLowerCase()}`;

const average = (values) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const requestJson = async ({ apiKey, baseUrl, body, endpoint }) => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const startedAt = performance.now();

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });
      const latencyMs = performance.now() - startedAt;
      const payload = await response.json();

      if (!response.ok || payload.success === false) {
        const message =
          typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : `Request to ${endpoint} failed with status ${response.status}.`;

        if (
          attempt < MAX_RETRIES &&
          (response.status === 429 || /rate limit|rate_limit_exceeded|try again in/i.test(message))
        ) {
          await sleep(getRetryDelayMs(message, attempt));
          continue;
        }

        throw new Error(message);
      }

      return {
        latencyMs,
        payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt < MAX_RETRIES && /rate limit|rate_limit_exceeded|try again in/i.test(message)) {
        await sleep(getRetryDelayMs(message, attempt));
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Request to ${endpoint} failed after ${MAX_RETRIES + 1} attempts.`);
};

const evaluateSuggestionsForScenario = async ({ apiKey, baseUrl, scenario }) => {
  const previousSuggestions = [];
  const allFingerprints = new Set();
  const duplicateFingerprints = new Set();
  const batches = [];
  const transcriptChunks = scenario.transcriptChunks;

  for (let index = 0; index < transcriptChunks.length; index += 2) {
    const currentWindow = transcriptChunks.slice(0, index + 2);
    const transcriptText = createTranscriptText(currentWindow);
    const transcriptChunk = currentWindow.at(-1) ?? "";
    let response;

    try {
      response = await requestJson({
        apiKey,
        baseUrl,
        endpoint: "/api/suggestions",
        body: {
          transcript_chunk: transcriptChunk,
          full_transcript: transcriptText,
          previous_suggestions: previousSuggestions,
          context_window: DEFAULT_CONTEXT_WINDOWS.suggestions,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Suggestions failed for scenario "${scenario.label}" batch ${batches.length + 1}: ${message}`,
      );
    }

    const { latencyMs, payload } = response;

    const typeSet = new Set(payload.suggestions.map((suggestion) => suggestion.type));
    const keywordMatches = scenario.keywords.filter((keyword) =>
      payload.suggestions.some((suggestion) =>
        `${suggestion.preview} ${suggestion.full_content}`.toLowerCase().includes(keyword.toLowerCase()),
      ),
    );

    payload.suggestions.forEach((suggestion) => {
      const fingerprint = buildSuggestionFingerprint(suggestion);

      if (allFingerprints.has(fingerprint)) {
        duplicateFingerprints.add(fingerprint);
      }

      allFingerprints.add(fingerprint);
      previousSuggestions.push(suggestion);
    });

    batches.push({
      batchNumber: batches.length + 1,
      latencyMs: Number(latencyMs.toFixed(1)),
      keywordHitCount: keywordMatches.length,
      keywordScore: Number(((keywordMatches.length / scenario.keywords.length) * 5).toFixed(2)),
      previewCount: payload.suggestions.length,
      suggestionTypes: [...typeSet],
      varietyScore: typeSet.size,
      suggestions: payload.suggestions,
    });
  }

  return {
    averageLatencyMs: Number(average(batches.map((batch) => batch.latencyMs)).toFixed(1)),
    duplicateCount: duplicateFingerprints.size,
    duplicateFingerprints: [...duplicateFingerprints],
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    suggestionBatches: batches,
  };
};

const evaluateChatForScenario = async ({ apiKey, baseUrl, scenario }) => {
  const transcriptText = createTranscriptText(scenario.transcriptChunks);
  const question = {
    "sales-call":
      "What should I say if the customer asks for a concise pricing and support summary right now?",
    "technical-discussion":
      "What is the most practical architecture change to reduce timeouts without overcomplicating the system?",
    "casual-standup":
      "What follow-up should I ask to unblock the team before the sprint demo?",
    "multiple-speakers":
      "What is the biggest coordination risk that should be resolved before launch?",
    "short-session":
      "What is the immediate answer we should give the client?",
    "long-session":
      "Summarize the main risks, owners, and next steps from this meeting.",
  }[scenario.id];

  let response;

  try {
    response = await requestJson({
      apiKey,
      baseUrl,
      endpoint: "/api/chat",
      body: {
        user_message: question,
        full_transcript: transcriptText,
        chat_history: [],
        context_window: DEFAULT_CONTEXT_WINDOWS.answers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Chat failed for scenario "${scenario.label}": ${message}`);
  }

  const { latencyMs, payload } = response;

  const answerText = String(payload.message ?? "");
  const keywordMatches = scenario.keywords.filter((keyword) =>
    answerText.toLowerCase().includes(keyword.toLowerCase()),
  );

  return {
    chatKeywordScore: Number(((keywordMatches.length / scenario.keywords.length) * 5).toFixed(2)),
    latencyMs: Number(latencyMs.toFixed(1)),
    question,
    response: answerText,
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
  };
};

const evaluatePerformanceChecks = async ({ apiKey, baseUrl }) => {
  const transcriptText = createTranscriptText(performanceChecks.manyChatMessages.transcriptChunks);
  const { latencyMs, payload } = await requestJson({
    apiKey,
    baseUrl,
    endpoint: "/api/chat",
    body: {
      user_message: performanceChecks.manyChatMessages.question,
      full_transcript: transcriptText,
      chat_history: performanceChecks.manyChatMessages.chatHistory,
      context_window: DEFAULT_CONTEXT_WINDOWS.answers,
    },
  });

  return {
    thirtyMessageChatLatencyMs: Number(latencyMs.toFixed(1)),
    thirtyMessageChatResponseLength: String(payload.message ?? "").length,
    transcriptChunkCount: performanceChecks.manyChatMessages.transcriptChunks.length,
  };
};

const createSummaryMarkdown = ({ chatResults, performanceResult, suggestionResults }) => {
  const lines = [
    "# TwinMind Evaluation Report",
    "",
    `Base URL: ${DEFAULT_BASE_URL}`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Suggestion Scenarios",
    "",
  ];

  suggestionResults.forEach((result) => {
    lines.push(`### ${result.scenarioLabel}`);
    lines.push(`- Average latency: ${result.averageLatencyMs} ms`);
    lines.push(`- Duplicate suggestions across batches: ${result.duplicateCount}`);
    lines.push("");

    result.suggestionBatches.forEach((batch) => {
      lines.push(
        `- Batch ${batch.batchNumber}: ${batch.latencyMs} ms, keyword score ${batch.keywordScore}/5, variety ${batch.varietyScore} types`,
      );
    });

    lines.push("");
  });

  lines.push("## Chat Scenarios", "");

  chatResults.forEach((result) => {
    lines.push(`### ${result.scenarioLabel}`);
    lines.push(`- Latency: ${result.latencyMs} ms`);
    lines.push(`- Keyword score: ${result.chatKeywordScore}/5`);
    lines.push("");
  });

  lines.push("## Performance Checks", "");
  lines.push(
    `- 30+ message chat latency: ${performanceResult.thirtyMessageChatLatencyMs} ms`,
  );
  lines.push(
    `- 30+ message chat response length: ${performanceResult.thirtyMessageChatResponseLength} characters`,
  );
  lines.push(
    `- Transcript chunk count used for long-context chat: ${performanceResult.transcriptChunkCount}`,
  );
  lines.push("");
  lines.push("## Manual Checks Still Required", "");
  lines.push("- Browser-level rapid speech drop behavior");
  lines.push("- Smooth scroll with many suggestion batches visible");
  lines.push("- Human relevance scoring on the 1-5 rubric");
  lines.push("- Multiple-speaker overlap fidelity using real microphone input");

  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const apiKey = process.env.GROQ_API_KEY ?? process.env.NEXT_PUBLIC_GROQ_API_KEY;

  if (!apiKey) {
    console.error(
      [
        "Missing GROQ_API_KEY.",
        "Set GROQ_API_KEY (or NEXT_PUBLIC_GROQ_API_KEY) and run the local app before executing this script.",
        `Example: GROQ_API_KEY=... npm run dev  # in one shell`,
        `Then: GROQ_API_KEY=... node scripts/evaluate-scenarios.mjs`,
      ].join("\n"),
    );
    process.exitCode = 1;

    return;
  }

  const suggestionResults = [];
  const chatResults = [];

  for (const scenario of scenarios) {
    suggestionResults.push(
      await evaluateSuggestionsForScenario({
        apiKey,
        baseUrl: DEFAULT_BASE_URL,
        scenario,
      }),
    );

    chatResults.push(
      await evaluateChatForScenario({
        apiKey,
        baseUrl: DEFAULT_BASE_URL,
        scenario,
      }),
    );
  }

  const performanceResult = await evaluatePerformanceChecks({
    apiKey,
    baseUrl: DEFAULT_BASE_URL,
  });

  const report = {
    baseUrl: DEFAULT_BASE_URL,
    generatedAt: new Date().toISOString(),
    chatResults,
    performanceResult,
    suggestionResults,
  };

  const markdown = createSummaryMarkdown({
    chatResults,
    performanceResult,
    suggestionResults,
  });

  await writeFile("evaluation-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile("evaluation-report.md", markdown, "utf8");

  console.log(markdown);
  console.log("Saved evaluation-report.json and evaluation-report.md");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
