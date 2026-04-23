import OpenAI from "openai";
import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import {
  APIKeyError,
  ChatGenerationError,
  TimeoutError,
  validateGroqApiKey,
} from "@/lib/groq-client";
import {
  extractGroundableEntities,
  type ExtractedEntity,
} from "@/lib/entity-extractor";
import { fetchGroundedFacts, getGroundingStats } from "@/lib/grounding";
import {
  getLargeModelClient,
  getLargeModelName,
  isLargeModelExpandedContext,
} from "@/lib/llm-clients";
import {
  buildChatSystemPrompt,
  buildChatUserTurnPrompt,
  DEFAULT_PROMPTS,
  type PromptGroundedFact,
} from "@/lib/prompts";
import { getServerGroqKey, SERVER_GROQ_KEY_MISSING_MESSAGE } from "@/lib/server-groq-key";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContextBundle,
  RollingSummary,
  SalientMoment,
  Suggestion,
  SuggestionMeta,
} from "@/lib/types";

export const runtime = "edge";

const ROLLING_SUMMARY_PHASES = new Set([
  "exploring",
  "converging",
  "deciding",
  "wrapping",
  "unclear",
]);
const ROLLING_SUMMARY_TONES = new Set([
  "analytical",
  "tense",
  "aligned",
  "stalled",
  "exploratory",
  "neutral",
]);
const SALIENT_CATEGORIES = new Set([
  "claim",
  "question",
  "decision",
  "commitment",
  "objection",
  "key_entity",
]);
const SALIENT_STATUSES = new Set(["open", "addressed"]);

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    (typeof candidate.timestamp === "string" || candidate.timestamp instanceof Date)
  );
};

const isChatRequestBody = (value: unknown): value is Pick<ChatRequest, "message" | "history"> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.message === "string" &&
    Array.isArray(candidate.history) &&
    candidate.history.every(isChatMessage)
  );
};

const isSuggestionMeta = (value: unknown): value is SuggestionMeta => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.meeting_type === "string" &&
    typeof candidate.conversation_stage === "string"
  );
};

const isRollingSummary = (value: unknown): value is RollingSummary => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.topic === "string" &&
    typeof candidate.stance === "string" &&
    typeof candidate.phase === "string" &&
    ROLLING_SUMMARY_PHASES.has(candidate.phase) &&
    typeof candidate.tone === "string" &&
    ROLLING_SUMMARY_TONES.has(candidate.tone) &&
    Array.isArray(candidate.participants_heard) &&
    candidate.participants_heard.every((participant) => typeof participant === "string")
  );
};

const isSalientMoment = (value: unknown): value is SalientMoment => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.timestamp === "number" &&
    typeof candidate.category === "string" &&
    SALIENT_CATEGORIES.has(candidate.category) &&
    typeof candidate.summary === "string" &&
    typeof candidate.verbatim === "string" &&
    typeof candidate.importance === "number" &&
    candidate.importance >= 1 &&
    candidate.importance <= 5 &&
    typeof candidate.status === "string" &&
    SALIENT_STATUSES.has(candidate.status)
  );
};

const isSuggestion = (value: unknown): value is Suggestion => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.preview === "string" &&
    typeof candidate.full_content === "string" &&
    typeof candidate.evidence_quote === "string" &&
    (candidate.trigger === undefined || typeof candidate.trigger === "string")
  );
};

const sanitizeContextBundle = (value: unknown): ContextBundle => {
  if (typeof value !== "object" || value === null) {
    return {
      rollingSummary: null,
      verbatimRecent: "",
      salientMemory: [],
      recentChatTopics: [],
    };
  }

  const candidate = value as Record<string, unknown>;

  return {
    rollingSummary: isRollingSummary(candidate.rollingSummary) ? candidate.rollingSummary : null,
    verbatimRecent: typeof candidate.verbatimRecent === "string" ? candidate.verbatimRecent : "",
    salientMemory: Array.isArray(candidate.salientMemory)
      ? candidate.salientMemory.filter(isSalientMoment)
      : [],
    meta: isSuggestionMeta(candidate.meta) ? candidate.meta : undefined,
    recentChatTopics: Array.isArray(candidate.recentChatTopics)
      ? candidate.recentChatTopics.filter((topic): topic is string => typeof topic === "string")
      : [],
  };
};

const sanitizeSuggestion = (value: unknown) => (isSuggestion(value) ? value : undefined);

const buildResponse = ({
  error,
  message,
  success,
  timestamp,
}: ChatResponse) => ({
  error,
  message,
  success,
  timestamp,
});

const CHAT_GROUNDING_BUDGET_MS = 800;
const CHAT_TIMEOUT_MS_STANDARD = 25_000;
const CHAT_TIMEOUT_MS_EXPANDED = 45_000;
const TRANSCRIPT_GROUNDING_TAIL_CHARS = 500;
const CHAT_GROUNDING_TRIGGER_PATTERN =
  /\b(price|pricing|cost|rate limit|quota|specs?|version|release|latest|available|compare|vs|versus)\b/i;
const CHAT_ALLOWED_GROUNDING_TYPES = new Set<ExtractedEntity["type"]>([
  "product",
  "brand",
  "cloud_service",
  "tech_stack",
  "metric",
  "standard",
  "company",
]);
const isContentFilterError = (err: unknown): boolean => {
  if (!(err instanceof Groq.APIError) && !(err instanceof OpenAI.APIError)) return false;
  const code = (err as { code?: string | null }).code ?? "";
  const msg = err.message ?? "";
  return code === "content_filter"
    || /content management policy/i.test(msg)
    || /responsibleaipolicyviolation/i.test(msg);
};

const getChatTimeoutMs = () =>
  isLargeModelExpandedContext() ? CHAT_TIMEOUT_MS_EXPANDED : CHAT_TIMEOUT_MS_STANDARD;

const buildChatHistoryContext = (chatHistory: ChatMessage[]) => {
  const recentMessages = chatHistory.slice(-8);

  if (recentMessages.length === 0) {
    return "No prior chat history.";
  }

  return recentMessages
    .map((message) => {
      const timestamp = message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : String(message.timestamp);

      return `[${timestamp}] ${message.role.toUpperCase()}: ${message.content}`;
    })
    .join("\n");
};

const buildGroundingInput = (message: string, fullTranscript: string) =>
  [message.trim(), fullTranscript.trim().slice(-TRANSCRIPT_GROUNDING_TAIL_CHARS)]
    .filter(Boolean)
    .join("\n\n");

const extractMostProminentNounPhrase = (message: string) => {
  const quotedMatch = message.match(/["“]([^"”]+)["”]/);

  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const capitalizedMatches = message.match(
    /(?:[A-Z][A-Za-z0-9.+-]*|\d+[A-Za-z0-9.+-]*)(?:\s+(?:[A-Z][A-Za-z0-9.+-]*|\d+[A-Za-z0-9.+-]*)){0,5}/g,
  );

  if (capitalizedMatches) {
    const candidate = capitalizedMatches
      .map((value) => value.trim())
      .find((value) => value.length >= 3 && !/^can you$/i.test(value));

    if (candidate) {
      return candidate;
    }
  }

  const prepositionMatch = message.match(
    /\b(?:for|of|about|compare|versus|vs)\s+([A-Za-z0-9.+-]+(?:\s+[A-Za-z0-9.+-]+){0,5})/i,
  );

  if (prepositionMatch?.[1]) {
    return prepositionMatch[1]
      .replace(/\b(?:price|pricing|cost|rate|limit|quota|specs?|version|release|latest|available)\b/gi, "")
      .trim();
  }

  return null;
};

const buildSyntheticEntity = (message: string): ExtractedEntity | null => {
  const name = extractMostProminentNounPhrase(message);

  if (!name) {
    return null;
  }

  return {
    name,
    type: "product",
    context: message.trim(),
  };
};

const getNormalizedSessionId = (
  payload: Record<string, unknown>,
  fullTranscript: string,
  history: ChatMessage[],
) => {
  if (typeof payload.session_id === "string" && payload.session_id.trim()) {
    return payload.session_id.trim();
  }

  const historySeed = history[0]?.id ?? "chat";
  const transcriptSeed = fullTranscript.trim().slice(0, 64) || "empty";

  return `${historySeed}:${transcriptSeed}`.slice(0, 128);
};

const getGroundedFactsForChat = async ({
  fullTranscript,
  groqApiKey,
  message,
  requestSignal,
  sessionId,
}: {
  fullTranscript: string;
  groqApiKey: string;
  message: string;
  requestSignal: AbortSignal;
  sessionId: string;
}): Promise<PromptGroundedFact[]> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const abortForRequest = () => controller.abort();
  requestSignal.addEventListener("abort", abortForRequest, { once: true });
  const timeoutId = globalThis.setTimeout(() => controller.abort(), CHAT_GROUNDING_BUDGET_MS);
  let entities: ExtractedEntity[] = [];
  let facts: PromptGroundedFact[] = [];

  try {
    const groundingInput = buildGroundingInput(message, fullTranscript);

    if (groundingInput) {
      entities = await extractGroundableEntities(groqApiKey, groundingInput, controller.signal);
      entities = entities
        .filter((entity) => CHAT_ALLOWED_GROUNDING_TYPES.has(entity.type))
        .slice(0, 3);
    }

    if (entities.length === 0 && CHAT_GROUNDING_TRIGGER_PATTERN.test(message)) {
      const syntheticEntity = buildSyntheticEntity(message);

      if (syntheticEntity) {
        entities = [syntheticEntity];
      }
    }

    if (entities.length > 0 && !controller.signal.aborted) {
      facts = await fetchGroundedFacts({
        entities,
        scope: message.trim(),
        sessionId,
        signal: controller.signal,
      });
    }
  } catch {
    facts = [];
  } finally {
    globalThis.clearTimeout(timeoutId);
    requestSignal.removeEventListener("abort", abortForRequest);
  }

  const stats = getGroundingStats(sessionId);
  const budgetRemaining =
    process.env.TAVILY_ENABLED !== "true" || !process.env.TAVILY_API_KEY?.trim()
      ? 0
      : stats.searches_remaining;
  console.info("[chat][grounding]", {
    entities_requested: entities.length,
    facts_returned: facts.length,
    cache_hits: stats.last_cache_hits ?? 0,
    budget_remaining: budgetRemaining,
    latency_ms: Date.now() - startedAt,
  });

  return facts;
};

type ChatCompletionStreamChunk = {
  choices: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
};

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();
  const payload: unknown = await request.json();

  console.info("[TwinMind][chat][route][reached]", {
    has_message: Boolean((payload as { message?: unknown } | null)?.message),
    history_len: Array.isArray((payload as { history?: unknown } | null)?.history)
      ? ((payload as { history: unknown[] }).history.length)
      : 0,
  });

  if (!isChatRequestBody(payload)) {
    return NextResponse.json(
      buildResponse({
        error: "Invalid chat payload.",
        message: "",
        success: false,
        timestamp,
      }),
      { status: 400 },
    );
  }

  if (payload.message.trim().length === 0) {
    return NextResponse.json(
      buildResponse({
        error: "Message is empty.",
        message: "",
        success: false,
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
          message: "",
          success: false,
          timestamp,
        }),
        { status: 500 },
      );
    }

    const resolvedApiKey = validateGroqApiKey(serverGroqKey);
    const candidate = payload as Record<string, unknown>;
    const context = sanitizeContextBundle(candidate.context);
    const suggestion = sanitizeSuggestion(candidate.suggestion);
    const fullTranscript =
      typeof candidate.full_transcript === "string"
        ? candidate.full_transcript
        : context.verbatimRecent;
    const sessionId = getNormalizedSessionId(candidate, fullTranscript, payload.history);
    const groundedFacts = await getGroundedFactsForChat({
      fullTranscript,
      groqApiKey: resolvedApiKey,
      message: payload.message,
      requestSignal: request.signal,
      sessionId,
    });
    const userTemplate = suggestion ? DEFAULT_PROMPTS.detailed_answer : DEFAULT_PROMPTS.chat;
    const userQueryKey = suggestion ? "{user_query}" : "{user_message}";
    const baseChatHistory = buildChatHistoryContext(payload.history.slice(-8));
    const client = getLargeModelClient(resolvedApiKey);
    const parsedMaxTokensOverride = Number.parseInt(
      process.env.CHAT_MAX_TOKENS ?? "",
      10,
    );
    const chatMaxTokens = Number.isFinite(parsedMaxTokensOverride) && parsedMaxTokensOverride > 0
      ? parsedMaxTokensOverride
      : isLargeModelExpandedContext()
        ? 4000
        : 2500;
    console.info("[TwinMind][chat][route][reached]", {
      timestamp,
      has_message: Boolean(payload.message),
      history_len: payload.history.length,
      transcript_len: fullTranscript.length,
      max_tokens: chatMaxTokens,
      model: getLargeModelName(),
    });
    let activeTier = 0;
    let systemPrompt = "";
    let userPrompt = "";
    const logFilterDiagnostics = (tier: number) => {
      console.error("[TwinMind][chat][route][filter_diag]", {
        system_chars: systemPrompt.length,
        user_chars: userPrompt.length,
        transcript_chars: fullTranscript.length,
        grounded_facts_count: groundedFacts.length,
        grounded_urls: groundedFacts.map((fact) => fact.url ?? "").slice(0, 5),
        history_len: payload.history.length,
        tier,
      });
    };

    const buildTierPrompts = (tier: number) => {
      switch (tier) {
        case 0:
          return {
            systemPrompt: buildChatSystemPrompt(context, suggestion, groundedFacts),
            userPrompt: buildChatUserTurnPrompt({
              template: userTemplate,
              fullTranscript,
              groundedFacts,
              chatHistory: baseChatHistory,
              userMessage: payload.message,
              userQueryKey,
            }),
          };
        case 1:
          return {
            systemPrompt: buildChatSystemPrompt(context, suggestion, []),
            userPrompt: buildChatUserTurnPrompt({
              template: userTemplate,
              fullTranscript,
              groundedFacts: [],
              chatHistory: baseChatHistory,
              userMessage: payload.message,
              userQueryKey,
            }),
          };
        case 2: {
          const trimmedContext: ContextBundle = {
            ...context,
            verbatimRecent: context.verbatimRecent.trim().slice(-600),
          };
          return {
            systemPrompt: buildChatSystemPrompt(trimmedContext, suggestion, []),
            userPrompt: buildChatUserTurnPrompt({
              template: userTemplate,
              fullTranscript: "",
              groundedFacts: [],
              chatHistory: baseChatHistory,
              userMessage: payload.message,
              userQueryKey,
            }),
          };
        }
        default:
          return {
            systemPrompt: "You are a helpful meeting assistant.",
            userPrompt: payload.message.trim(),
          };
      }
    };

    let completionStream: AsyncIterable<ChatCompletionStreamChunk> | undefined;

    for (let tier = 0; tier <= 3; tier += 1) {
      activeTier = tier;
      const tierPrompts = buildTierPrompts(tier);
      systemPrompt = tierPrompts.systemPrompt;
      userPrompt = tierPrompts.userPrompt;

      try {
        completionStream = await client.chat.completions.create(
          {
            model: getLargeModelName(),
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: userPrompt,
              },
            ],
            response_format: {
              type: "text",
            },
            temperature: 0.3,
            max_tokens: chatMaxTokens,
            stream: true,
          },
          {
            timeout: getChatTimeoutMs(),
            maxRetries: 0,
            signal: request.signal,
          },
        ) as AsyncIterable<ChatCompletionStreamChunk>;
        break;
      } catch (error) {
        if (!isContentFilterError(error)) {
          throw error;
        }

        const status =
          error instanceof Groq.APIError || error instanceof OpenAI.APIError
            ? error.status
            : undefined;
        const code =
          error instanceof Groq.APIError || error instanceof OpenAI.APIError
            ? (error as { code?: string | null }).code ?? null
            : null;
        const message = error instanceof Error ? error.message : String(error);

        console.warn("[TwinMind][chat][route][filter_retry]", {
          tier,
          status,
          code,
          message,
        });
        logFilterDiagnostics(tier);

        if (tier === 3) {
          console.error("[TwinMind][chat][route][error]", {
            code: "content_filter_exhausted",
            tier,
          });
          return NextResponse.json(
            buildResponse({
              error:
                "Azure content filter blocked this prompt. Try rephrasing your question or disable sensitive topics in context.",
              message: "",
              success: false,
              timestamp,
            }),
            { status: 422 },
          );
        }
      }
    }

    if (!completionStream) {
      return NextResponse.json(
        buildResponse({
          error:
            "Azure content filter blocked this prompt. Try rephrasing your question or disable sensitive topics in context.",
          message: "",
          success: false,
          timestamp,
        }),
        { status: 422 },
      );
    }
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sendEvent = (value: string) => {
          if (request.signal.aborted) {
            return;
          }
          controller.enqueue(encoder.encode(value));
        };

        try {
          let sawContentDelta = false;
          let reasoningFallback = "";

          for await (const chunk of completionStream) {
            const token = chunk.choices[0]?.delta?.content ?? "";
            const reasoningToken =
              (
                chunk.choices[0]?.delta as
                  | {
                      reasoning_content?: string | null;
                    }
                  | undefined
              )?.reasoning_content ?? "";

            if (!token) {
              if (reasoningToken) {
                reasoningFallback += reasoningToken;
              }
              continue;
            }

            sawContentDelta = true;
            sendEvent(`data: ${JSON.stringify({ token })}\n\n`);
          }

          if (!sawContentDelta && reasoningFallback.trim()) {
            sendEvent(`data: ${JSON.stringify({ token: reasoningFallback.trim() })}\n\n`);
          }

          sendEvent("data: [DONE]\n\n");
          controller.close();
        } catch (error) {
          if (request.signal.aborted) {
            controller.close();
            return;
          }

          if (isContentFilterError(error)) {
            const status =
              error instanceof Groq.APIError || error instanceof OpenAI.APIError
                ? error.status
                : undefined;
            const code =
              error instanceof Groq.APIError || error instanceof OpenAI.APIError
                ? (error as { code?: string | null }).code ?? null
                : null;
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[TwinMind][chat][route][filter_retry]", {
              tier: activeTier,
              status,
              code,
              message,
            });
            logFilterDiagnostics(activeTier);
            sendEvent(`data: ${JSON.stringify({ error: "Content filter blocked this reply. Try rephrasing." })}\n\n`);
            controller.close();
            return;
          }

          const upstreamStatus =
            error instanceof Groq.APIError || error instanceof OpenAI.APIError
              ? (error as { status?: number }).status
              : undefined;
          const upstreamCode =
            error instanceof Groq.APIError || error instanceof OpenAI.APIError
              ? (error as { code?: string | null }).code ?? null
              : null;
          const rawMessage =
            error instanceof Error ? error.message : "The response stream ended unexpectedly.";

          console.error("[TwinMind][chat][route][stream_error]", {
            name: error instanceof Error ? error.name : typeof error,
            status: upstreamStatus,
            code: upstreamCode,
            message: rawMessage,
          });

          const errorMessage = upstreamStatus
            ? `Upstream ${upstreamStatus}${upstreamCode ? ` (${upstreamCode})` : ""}: ${rawMessage}`
            : rawMessage;

          sendEvent(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (isContentFilterError(error)) {
      return NextResponse.json(
        buildResponse({
          error:
            "Azure content filter blocked this prompt. Try rephrasing your question or disable sensitive topics in context.",
          message: "",
          success: false,
          timestamp,
        }),
        { status: 422 },
      );
    }

    const upstreamStatus =
      error instanceof Groq.APIError || error instanceof OpenAI.APIError
        ? (error as { status?: number }).status
        : undefined;
    const upstreamCode =
      error instanceof Groq.APIError || error instanceof OpenAI.APIError
        ? (error as { code?: string | null }).code ?? null
        : null;
    const upstreamParam =
      error instanceof Groq.APIError || error instanceof OpenAI.APIError
        ? (error as { param?: string | null }).param ?? null
        : null;
    const upstreamType =
      error instanceof Groq.APIError || error instanceof OpenAI.APIError
        ? (error as { type?: string | null }).type ?? null
        : null;

    console.error("[TwinMind][chat][route][error]", {
      name: error instanceof Error ? error.name : typeof error,
      status: upstreamStatus,
      code: upstreamCode,
      param: upstreamParam,
      type: upstreamType,
      message: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof APIKeyError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          message: "",
          success: false,
          timestamp,
        }),
        { status: 401 },
      );
    }

    if (error instanceof TimeoutError) {
      return NextResponse.json(
        buildResponse({
          error: error.message,
          message: "",
          success: false,
          timestamp,
        }),
        { status: 504 },
      );
    }

    if (error instanceof Groq.APIError || error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return NextResponse.json(
          buildResponse({
            error: "Invalid API key",
            message: "",
            success: false,
            timestamp,
          }),
          { status: 401 },
        );
      }

      if (error.status === 429) {
        return NextResponse.json(
          buildResponse({
            error: "Rate limit hit",
            message: "",
            success: false,
            timestamp,
          }),
          { status: 429 },
        );
      }

      if (error.status === 408 || error.name === "APITimeoutError") {
        return NextResponse.json(
          buildResponse({
            error: "Request timeout",
            message: "",
            success: false,
            timestamp,
          }),
          { status: 504 },
        );
      }

      if (typeof error.status === "number" && error.status >= 400 && error.status < 600) {
        const detail = [upstreamCode, upstreamParam].filter(Boolean).join(" / ");
        const providerMessage = error.message || "Upstream provider error";
        return NextResponse.json(
          buildResponse({
            error: `Upstream ${error.status}${detail ? ` (${detail})` : ""}: ${providerMessage}`,
            message: "",
            success: false,
            timestamp,
          }),
          { status: error.status },
        );
      }
    }

    const errorMessage =
      error instanceof ChatGenerationError
        ? error.message
        : error instanceof Error
          ? `Chat failed: ${error.message}`
          : "Failed to generate a detailed answer.";

    return NextResponse.json(
      buildResponse({
        error: errorMessage,
        message: "",
        success: false,
        timestamp,
      }),
      { status: 500 },
    );
  }
}
