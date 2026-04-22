import { OpenAI } from "openai";

const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-oss-120b";
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export function isAzureConfigured(): boolean {
  return Boolean(AZURE_ENDPOINT && AZURE_KEY);
}

// Safe on both server (reads private Azure vars) and client (reads the
// NEXT_PUBLIC mirror, which Next.js inlines at build time). If neither is
// present the call resolves to `false` and the standard context path is used.
export function isLargeModelExpandedContext(): boolean {
  if (isAzureConfigured()) {
    return true;
  }

  return process.env.NEXT_PUBLIC_LARGE_MODEL_EXPANDED === "true";
}

export function getLargeModelName(): string {
  return isAzureConfigured() ? AZURE_DEPLOYMENT : "openai/gpt-oss-120b";
}

export function getLargeModelClient(groqFallbackKey: string): OpenAI {
  if (isAzureConfigured()) {
    console.log("[azure-debug]", {
      endpoint: AZURE_ENDPOINT,
      deployment: AZURE_DEPLOYMENT,
      apiVersion: AZURE_API_VERSION,
      baseURL: `${AZURE_ENDPOINT!.replace(/\/+$/, "")}/models`,
    });

    return new OpenAI({
      apiKey: AZURE_KEY!,
      baseURL: `${AZURE_ENDPOINT!.replace(/\/+$/, "")}/models`,
      defaultHeaders: { "api-key": AZURE_KEY! },
      defaultQuery: { "api-version": AZURE_API_VERSION },
    });
  }

  return new OpenAI({
    apiKey: groqFallbackKey,
    baseURL: GROQ_BASE_URL,
  });
}
