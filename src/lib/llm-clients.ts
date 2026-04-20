import { OpenAI } from "openai";

const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-oss-120b";
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export function isAzureConfigured(): boolean {
  return Boolean(AZURE_ENDPOINT && AZURE_KEY);
}

export function isLargeModelExpandedContext(): boolean {
  return isAzureConfigured();
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
