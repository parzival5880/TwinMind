export interface TavilyResult {
  entity: string;
  scope: string;
  fact: string;
  url: string;
  title: string;
  published_date?: string;
}

type TavilyResponse = {
  answer?: string;
  results?: Array<{
    published_date?: string;
    title?: string;
    url?: string;
  }>;
};

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

const parseTimeoutMs = (value: string | undefined, fallbackMs: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

const isTavilyGroundingEnabled = () =>
  process.env.TAVILY_ENABLED !== "false" && Boolean(process.env.TAVILY_API_KEY?.trim());

export async function tavilySearch(
  query: string,
  opts?: { entity?: string; scope?: string; timeoutMs?: number; abortSignal?: AbortSignal },
): Promise<TavilyResult | null> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    console.warn("[tavily] failed", { query, reason: "empty_query" });
    return null;
  }

  if (!isTavilyGroundingEnabled()) {
    console.warn("[tavily] failed", { query: normalizedQuery, reason: "grounding_off" });
    return null;
  }

  const apiKey = process.env.TAVILY_API_KEY?.trim();

  if (!apiKey) {
    console.warn("[tavily] failed", { query: normalizedQuery, reason: "missing_api_key" });
    return null;
  }

  const timeoutMs = opts?.timeoutMs ?? parseTimeoutMs(process.env.TAVILY_TIMEOUT_MS, 2_000);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts?.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: normalizedQuery,
        api_key: apiKey,
        search_depth: "basic",
        max_results: 3,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn("[tavily] failed", {
        query: normalizedQuery,
        reason: `http_${response.status}`,
      });
      return null;
    }

    const payload = (await response.json()) as TavilyResponse;
    const answer = payload.answer?.trim();
    const topResult = payload.results?.[0];
    const url = topResult?.url?.trim();
    const title = topResult?.title?.trim();
    const publishedDate = topResult?.published_date?.trim();

    if (!answer || !url || !title) {
      console.warn("[tavily] failed", {
        query: normalizedQuery,
        reason: "incomplete_response",
      });
      return null;
    }

    return {
      entity: opts?.entity?.trim() || normalizedQuery,
      scope: opts?.scope?.trim() || "",
      fact: answer,
      url,
      title,
      published_date: publishedDate || undefined,
    };
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "AbortError"
        ? opts?.abortSignal?.aborted
          ? "aborted"
          : "timeout"
        : error instanceof Error
          ? error.name || "network_error"
          : "unknown_error";

    console.warn("[tavily] failed", { query: normalizedQuery, reason });
    return null;
  } finally {
    opts?.abortSignal?.removeEventListener("abort", onAbort);
    globalThis.clearTimeout(timeoutId);
  }
}
