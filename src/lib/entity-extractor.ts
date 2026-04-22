import Groq from "groq-sdk";
import { validateGroqApiKey } from "@/lib/groq-client";
import { ENTITY_EXTRACTION_PROMPT } from "@/lib/prompts";

export interface ExtractedEntity {
  name: string;
  type:
    | "product"
    | "brand"
    | "cloud_service"
    | "tech_stack"
    | "metric"
    | "standard"
    | "company"
    | "person";
  context: string;
}

type EntityExtractionResponse = {
  entities?: Array<{
    name?: string;
    type?: ExtractedEntity["type"];
    context?: string;
  }>;
};

const ENTITY_EXTRACTION_MODEL = "llama-3.1-8b-instant";
const ENTITY_EXTRACTION_TIMEOUT_MS = 800;
const ENTITY_EXTRACTION_MAX_TOKENS = 400;
const ENTITY_EXTRACTION_INPUT_MAX_CHARS = 4000;
const ENTITY_TYPES = new Set<ExtractedEntity["type"]>([
  "product",
  "brand",
  "cloud_service",
  "tech_stack",
  "metric",
  "company",
  "person",
  "standard",
]);

const truncateVerbatimText = (value: string) => value.trim().slice(-ENTITY_EXTRACTION_INPUT_MAX_CHARS);

const normalizeEntity = (value: unknown): ExtractedEntity | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.name !== "string" ||
    typeof candidate.type !== "string" ||
    typeof candidate.context !== "string" ||
    !ENTITY_TYPES.has(candidate.type as ExtractedEntity["type"])
  ) {
    return null;
  }

  const name = candidate.name.trim();
  const context = candidate.context.trim();

  if (!name || !context) {
    return null;
  }

  return {
    name,
    type: candidate.type as ExtractedEntity["type"],
    context,
  };
};

export async function extractGroundableEntities(
  groqApiKey: string,
  verbatimText: string,
  abortSignal?: AbortSignal,
): Promise<ExtractedEntity[]> {
  const transcriptBlock = truncateVerbatimText(verbatimText);

  if (!transcriptBlock) {
    return [];
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = globalThis.setTimeout(() => controller.abort(), ENTITY_EXTRACTION_TIMEOUT_MS);

  try {
    const client = new Groq({
      apiKey: validateGroqApiKey(groqApiKey),
      dangerouslyAllowBrowser: false,
      maxRetries: 0,
      timeout: ENTITY_EXTRACTION_TIMEOUT_MS,
    });

    const completion = await client.chat.completions.create(
      {
        model: ENTITY_EXTRACTION_MODEL,
        messages: [
          { role: "system", content: ENTITY_EXTRACTION_PROMPT },
          {
            role: "user",
            content: `Verbatim transcript:\n${transcriptBlock}`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: ENTITY_EXTRACTION_MAX_TOKENS,
      },
      {
        timeout: ENTITY_EXTRACTION_TIMEOUT_MS,
        maxRetries: 0,
        signal: controller.signal,
      },
    );

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      return [];
    }

    const parsed = JSON.parse(rawContent) as EntityExtractionResponse;
    const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
    const normalized = entities
      .map((entity) => normalizeEntity(entity))
      .filter((entity): entity is ExtractedEntity => entity !== null);

    const deduped: ExtractedEntity[] = [];
    const seenNames = new Set<string>();

    for (const entity of normalized) {
  const fingerprint = `${entity.name.toLowerCase()}::${entity.context.toLowerCase()}`;

      if (seenNames.has(fingerprint)) {
        continue;
      }

      seenNames.add(fingerprint);
      deduped.push(entity);

      if (deduped.length === 5) {
        break;
      }
    }

    return deduped;
  } catch {
    return [];
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    globalThis.clearTimeout(timeoutId);
  }
}
