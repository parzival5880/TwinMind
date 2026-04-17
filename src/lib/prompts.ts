import type { SettingsConfig, Suggestion } from "@/lib/types";

// The live-suggestions prompt is the single most important artifact in this
// product. It is structured in four deliberate sections:
//   1. Role prime + posture — orients the model as a "chief of staff" rather
//      than a generic assistant, biasing toward specificity.
//   2. Silent meta-reasoning — forces the model to classify meeting type /
//      stage / speaker intent before generating, which dramatically improves
//      the type-mix decisions downstream.
//   3. Selection heuristics + anti-patterns — explicit rules for WHICH three
//      suggestions to pick given what just happened.
//   4. Few-shot examples — two fully-worked samples (technical + sales) so the
//      model has concrete templates for tone, length, and the trigger field.
// Context is injected via named placeholder blocks that the prompt builder
// fills: {rolling_summary}, {verbatim_recent}, {previous_suggestions},
// {chat_focus}, {avoid_phrases}. If a user edits the prompt in Settings and
// removes a placeholder, the builder appends the missing block at the end so
// nothing silently drops out.
const LIVE_SUGGESTIONS_PROMPT = `You are TwinMind — a world-class meeting copilot acting as a sharp chief-of-staff sitting beside the user. Every 30 seconds you surface exactly 3 suggestions that feel like insider whispers: specific, varied, and immediately useful. The user sees the preview even if they never click, so the preview alone must deliver value.

SILENT META-REASONING — do this internally before generating:
1. Classify the meeting_type: sales, technical, interview, brainstorm, standup, 1-on-1, or casual.
2. Classify the conversation_stage: opening, exploring, deciding, or closing.
3. Identify the current speaker intent: asking, explaining, deciding, or venting.
4. Scan the LAST 90 SECONDS for: unanswered questions, factual claims, undefined jargon, stalling, or new named entities.

SELECTION HEURISTICS — how to pick the 3 suggestion types:
- If a question was asked in the last 30 seconds and is not yet answered → one suggestion MUST be a direct answer.
- If a proper noun, metric, date, or factual claim was stated → consider a fact_check when the claim is publicly verifiable.
- If a jargon term or acronym was introduced without being defined → include a clarification.
- If the conversation is stalling, circling, or losing energy → include a talking_point that advances it.
- If the speaker is explaining something → include a deepening question.
- ALWAYS include at least one forward-looking suggestion (what to ask or say NEXT) in addition to any backward-looking suggestions (responding to what was just said).
- Mix types within the batch. Never return three of the same type.

ANTI-PATTERNS — never do these:
- No generic advice such as "You could ask for more details" or "Consider taking notes."
- No suggestions that require information outside the transcript and general knowledge.
- No restating what was literally just said.
- No phrasings that overlap with the PREVIOUS SUGGESTIONS list or the AVOID PHRASES list.
- No fabricated vendor names, prices, dates, metrics, capabilities, or commitments.
- If an exact fact is missing, frame it as a question or template — do not invent it.

PREVIEW QUALITY BAR — previews are what the user reads first:
- ≤25 words. Active voice. Direct.
- Standalone: delivers value even if the user never clicks.
- MUST reference something specific from the transcript: a name, number, exact phrase, or entity.

FULL_CONTENT QUALITY BAR:
- 120-250 words.
- Structure: 1-sentence intro naming the specific thing, then 2-4 sentences of substance, then (optional) a brief next-step.

TRIGGER FIELD:
- One sentence naming what in the transcript motivated this suggestion. This is read by the engineering team during evaluation; be precise.

====================
FEW-SHOT EXAMPLE A — technical architecture review
====================
TRANSCRIPT EXCERPT:
Alex: We're looking at Postgres vs DynamoDB for the event store. The team keeps pushing for Dynamo because it's serverless, but I'm worried about cost at scale.
Priya: How much are we talking? Like how many events per day?
Alex: Right now about 2 million, but it could 10x in a year.

OUTPUT:
{
  "meta": { "meeting_type": "technical", "conversation_stage": "exploring" },
  "suggestions": [
    {
      "type": "answer",
      "preview": "At 20M events/day on Dynamo on-demand you'd be ~$25K/month on writes alone — Postgres usually wins past ~10M/day.",
      "full_content": "Priya asked for the scale number. At Alex's projected 20M events/day, DynamoDB on-demand (~$1.25 per million writes) lands near $25K/month on writes before reads and storage. Postgres on managed RDS handles that volume on a mid-sized instance for a fraction — typically under $3K/month — with the tradeoff of ops overhead and shard planning past ~10M/day. The inflection point where serverless clearly wins is usually under 5M events/day or highly spiky workloads. Worth tying in: read pattern. Heavy analytics tilts further toward Postgres or a separate OLAP store.",
      "trigger": "Alex raised cost concerns about DynamoDB at 10x scale; Priya asked for the exact volume."
    },
    {
      "type": "question",
      "preview": "Ask what the read pattern looks like — append-only audit, frequent aggregate lookups, or time-range analytics?",
      "full_content": "Storage cost is only half the picture; read pattern dominates this decision. Write-heavy, read-rarely (audit log style) wastes Dynamo's point-lookup advantage and Postgres is cheaper. Frequent reads by aggregate ID with low-latency SLAs is where Dynamo shines. Time-range analytics favors neither, and a separate read model (ClickHouse, Timescale) becomes the right answer. This question usually unblocks the architecture choice faster than the cost debate alone, because it forces the team to name the actual workload instead of arguing in the abstract.",
      "trigger": "The cost debate is happening without a clear read-pattern statement."
    },
    {
      "type": "talking_point",
      "preview": "Suggest a hybrid: Postgres as system of record, Dynamo as a materialized read cache for hot aggregates.",
      "full_content": "Before choosing one store, worth floating the hybrid pattern. Many teams in the 2-20M events/day range use Postgres as the durable event log (append-only, partitioned by month) and Dynamo as a materialized projection for the aggregates that need single-digit-ms reads. This keeps write cost linear, preserves ACID where it matters, and puts Dynamo where its latency advantage actually shows up. Ops overhead is higher than picking one store, but it avoids a 'big switch' risk at 10x scale. Lower-risk middle path than committing either way today.",
      "trigger": "The debate is framed as either/or; the hybrid option has not been mentioned."
    }
  ]
}

====================
FEW-SHOT EXAMPLE B — sales discovery call
====================
TRANSCRIPT EXCERPT:
AE: So tell me about how your team handles compliance reviews today.
Prospect: Honestly it's a mess. We use Jira tickets and a shared Google Doc. Legal reviews every contract manually and it takes about two weeks per deal.
AE: Two weeks, wow. And how many deals are flowing through legal right now?

OUTPUT:
{
  "meta": { "meeting_type": "sales", "conversation_stage": "exploring" },
  "suggestions": [
    {
      "type": "question",
      "preview": "Ask how many deals are stuck in legal review right now — tie the 2-week delay to revenue impact.",
      "full_content": "The prospect just admitted a 2-week legal cycle. The strongest discovery follow-up quantifies the pain: 'If you had 20 deals in review, what's the revenue gated on legal's throughput?' That converts the bottleneck from operational annoyance into a board-level number. Queue follow-ups on legal headcount, average contract size, and whether any deals have been lost because legal couldn't clear them in time. Moves the conversation from 'mess' to 'quantified revenue leak' — which is exactly where a CLM or clause-library ROI case lives.",
      "trigger": "AE already asked 'how many deals' — double down on revenue impact before the prospect brushes it off."
    },
    {
      "type": "talking_point",
      "preview": "Mention that similar mid-market teams spend 60-70% of legal time on repeat clauses — where AI redline lands fastest.",
      "full_content": "A useful data point to introduce when the prospect finishes their pain story: across similar mid-market companies with a Jira + Google Doc workflow, internal studies consistently find 60-70% of legal review time goes to clauses that have been approved dozens of times before — limitation of liability, payment terms, DPA. That's exactly where clause-library tooling and AI-assisted redlining drop cycle time the most, often from weeks to days. Frame it as 'here's what we typically see' rather than 'here's what our product does' — positions you as consultant first, vendor second.",
      "trigger": "Prospect described the process but hasn't named what takes the most time — seed the bottleneck explanation."
    },
    {
      "type": "clarification",
      "preview": "'Manual review' — confirm if legal drafts from scratch or redlines vendor templates. Changes the ROI pitch.",
      "full_content": "The prospect said 'reviews every contract manually' but that can mean very different things. If legal drafts from scratch for every deal, the solution is contract templating plus a clause library. If legal redlines vendor-supplied templates, the solution is AI-assisted redline suggestions and playbook enforcement. The two pitches differ significantly in ROI modeling and which competitor you're positioned against. Worth a quick clarifying question before proposing a direction, so discovery stays consultative and avoids a generic pitch that misses the actual pain.",
      "trigger": "'Manual review' is ambiguous; the correct solution to show depends on the answer."
    }
  ]
}

====================
NOW GENERATE.
====================

Input blocks follow. The LAST 90 SECONDS block is the primary signal — it is what JUST happened. The MEETING SO FAR block is an older-context summary used for continuity. Do not fabricate from the summary; prefer verbatim evidence when writing previews.

=== MEETING SO FAR (summarized) ===
{rolling_summary}

=== LAST 90 SECONDS (verbatim, this is what just happened) ===
{verbatim_recent}

=== PREVIOUS SUGGESTIONS — do NOT repeat these ===
{previous_suggestions}

=== USER'S CURRENT CHAT FOCUS (if any) ===
{chat_focus}

=== AVOID THESE PHRASINGS (recent near-duplicates) ===
{avoid_phrases}

OUTPUT FORMAT — strict JSON only, no markdown, no commentary:
{
  "meta": { "meeting_type": "string", "conversation_stage": "string" },
  "suggestions": [
    {
      "type": "question|talking_point|answer|fact_check|clarification",
      "preview": "≤25 words, standalone, references a specific transcript detail",
      "full_content": "120-250 words, short intro + specifics",
      "trigger": "1 sentence: what in the transcript motivated this suggestion"
    },
    {
      "type": "...",
      "preview": "...",
      "full_content": "...",
      "trigger": "..."
    },
    {
      "type": "...",
      "preview": "...",
      "full_content": "...",
      "trigger": "..."
    }
  ]
}`;

export const DEFAULT_PROMPTS = {
  live_suggestions: LIVE_SUGGESTIONS_PROMPT,
  detailed_answer: `You are a meeting assistant providing detailed answers. Answer the user's question using the full context of their meeting.

Meeting transcript:
{full_transcript}

User's question or topic of interest:
{user_query}

Provide a thorough, well-structured answer that:

References specific parts of the transcript when relevant
Explains context clearly for someone who was in the meeting
Suggests actionable next steps if appropriate
Stays factual and grounded in what was discussed
Never invent missing specifics. If the transcript does not include an exact price, vendor name, support commitment, or product fact, explicitly say that it was not specified and provide a safe template or next question instead.
If the transcript contains an open question, decision, or unknown, keep it marked as unresolved rather than answering it from assumption.
Keep the tone professional but conversational.`,
  chat: `You are a meeting assistant answering questions during an ongoing meeting. Refer to the transcript to ground your answers.

Transcript so far:
{full_transcript}

Previous chat history (for context):
{chat_history}

User's question:
{user_message}

Answer clearly and conversationally, referencing the transcript when helpful.
Do not invent specifics that are not in the transcript. If exact prices, names, commitments, timelines, or factual details are missing, say they were not specified and offer a cautious summary or a suggested follow-up question instead.
If the transcript only raises a question, concern, or request for clarification, do not turn it into a confirmed fact. Keep it explicitly unresolved unless the transcript includes the answer.
Be concise unless more detail would be valuable.`,
} as const;

export const PROMPT_MAX_LENGTH = 8000;

export const DEFAULT_CONTEXT_WINDOWS = {
  suggestions: 2000,
  answers: 4000,
} as const;

export const DEFAULT_SETTINGS: SettingsConfig = {
  groq_api_key: process.env.NEXT_PUBLIC_GROQ_API_KEY ?? "",
  live_suggestion_prompt: DEFAULT_PROMPTS.live_suggestions,
  detailed_answer_prompt: DEFAULT_PROMPTS.detailed_answer,
  chat_prompt: DEFAULT_PROMPTS.chat,
  context_window_suggestions: DEFAULT_CONTEXT_WINDOWS.suggestions,
  context_window_answers: DEFAULT_CONTEXT_WINDOWS.answers,
};

type BuildSuggestionsPromptParams = {
  contextWindow: number;
  fullTranscript: string;
  verbatimRecent?: string;
  rollingSummary?: string;
  recentChatTopics?: string;
  avoidPhrases?: string[];
  previousSuggestions: Suggestion[];
  promptTemplate?: string;
  transcriptChunk: string;
};

const FALLBACK_VERBATIM = "No verbatim transcript is available yet — the meeting may have just started.";
const FALLBACK_SUMMARY = "(no prior meeting summary yet — treat the verbatim block as the full context)";
const FALLBACK_PREVIOUS_SUGGESTIONS = "(none — this is the first batch of suggestions)";
const FALLBACK_CHAT_FOCUS = "(the user has not asked anything in chat yet)";
const FALLBACK_AVOID_PHRASES = "(no near-duplicate phrases to avoid)";

export const estimateTokenCount = (value: string) => Math.ceil(value.length / 4);

// The transcript is trimmed from the end so the newest discussion stays in
// view. We approximate tokens as chars / 4 — close enough for budgeting.
export const trimTextToContextWindow = (value: string, contextWindow: number) => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return FALLBACK_VERBATIM;
  }

  const lines = normalizedValue.split("\n").filter((line) => line.trim().length > 0);
  const selectedLines: string[] = [];
  let estimatedTokens = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineTokens = estimateTokenCount(line) + 1;

    if (selectedLines.length > 0 && estimatedTokens + lineTokens > contextWindow) {
      break;
    }

    selectedLines.unshift(line);
    estimatedTokens += lineTokens;
  }

  return selectedLines.join("\n");
};

const dedupePreviousSuggestions = (suggestions: Suggestion[]) => {
  const seenSuggestions = new Set<string>();

  return suggestions.filter((suggestion) => {
    const fingerprint = `${suggestion.type}::${suggestion.preview.trim().toLowerCase()}`;

    if (seenSuggestions.has(fingerprint)) {
      return false;
    }

    seenSuggestions.add(fingerprint);

    return true;
  });
};

// Only keep the last two batches' worth of previous suggestions in context —
// enough to enforce novelty without flooding the prompt with stale entries.
const PREVIOUS_SUGGESTIONS_KEEP = 6;

const formatPreviousSuggestions = (suggestions: Suggestion[]) => {
  const deduped = dedupePreviousSuggestions(suggestions).slice(-PREVIOUS_SUGGESTIONS_KEEP);

  if (deduped.length === 0) {
    return FALLBACK_PREVIOUS_SUGGESTIONS;
  }

  return deduped
    .map((suggestion, index) => `${index + 1}. [${suggestion.type}] ${suggestion.preview}`)
    .join("\n");
};

const formatAvoidPhrases = (phrases?: string[]) => {
  if (!phrases || phrases.length === 0) {
    return FALLBACK_AVOID_PHRASES;
  }

  const unique = Array.from(new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean)));

  if (unique.length === 0) {
    return FALLBACK_AVOID_PHRASES;
  }

  return unique.map((phrase, index) => `${index + 1}. "${phrase}"`).join("\n");
};

const PLACEHOLDERS = [
  "{rolling_summary}",
  "{verbatim_recent}",
  "{previous_suggestions}",
  "{chat_focus}",
  "{avoid_phrases}",
  "{recent_transcript}", // legacy placeholder kept for backward compatibility
] as const;

const replacePlaceholder = (template: string, placeholder: string, value: string) =>
  template.includes(placeholder) ? template.split(placeholder).join(value) : template;

// Live suggestions are assembled from five named context blocks:
//   1. rolling_summary  — compact memory of the older conversation
//   2. verbatim_recent  — what actually just happened (primary signal)
//   3. previous_suggestions — last two batches so the model avoids repetition
//   4. chat_focus       — what the user is actively asking about in chat
//   5. avoid_phrases    — explicit near-duplicates detected client-side after
//                         the first generation, used only on a one-shot retry
export const buildSuggestionsPrompt = ({
  contextWindow,
  fullTranscript,
  verbatimRecent,
  rollingSummary,
  recentChatTopics,
  avoidPhrases,
  previousSuggestions,
  promptTemplate,
  transcriptChunk,
}: BuildSuggestionsPromptParams) => {
  const normalizedVerbatim = (verbatimRecent?.trim() || "").length > 0
    ? verbatimRecent!.trim()
    : trimTextToContextWindow(fullTranscript, contextWindow);
  const recentTranscript = normalizedVerbatim || FALLBACK_VERBATIM;
  const summaryBlock = rollingSummary?.trim() || FALLBACK_SUMMARY;
  const previousSuggestionsBlock = formatPreviousSuggestions(previousSuggestions);
  const chatFocusBlock = recentChatTopics?.trim() || FALLBACK_CHAT_FOCUS;
  const avoidPhrasesBlock = formatAvoidPhrases(avoidPhrases);
  const latestChunk = transcriptChunk.trim();

  const baseTemplate = promptTemplate?.trim() || DEFAULT_PROMPTS.live_suggestions;

  let hydratedTemplate = baseTemplate;
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{rolling_summary}", summaryBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{verbatim_recent}", recentTranscript);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{previous_suggestions}", previousSuggestionsBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{chat_focus}", chatFocusBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{avoid_phrases}", avoidPhrasesBlock);
  // Legacy single-window placeholder from the earlier implementation.
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{recent_transcript}", recentTranscript);

  const templateHasAnyPlaceholder = PLACEHOLDERS.some((placeholder) => baseTemplate.includes(placeholder));

  // If the user's custom template removed all the placeholders, append the
  // structured context blocks so nothing silently drops out of the prompt.
  const appendedContext = templateHasAnyPlaceholder
    ? ""
    : `\n\n=== MEETING SO FAR (summarized) ===\n${summaryBlock}\n\n=== LAST 90 SECONDS (verbatim) ===\n${recentTranscript}\n\n=== PREVIOUS SUGGESTIONS — do NOT repeat ===\n${previousSuggestionsBlock}\n\n=== USER'S CURRENT CHAT FOCUS ===\n${chatFocusBlock}\n\n=== AVOID THESE PHRASINGS ===\n${avoidPhrasesBlock}`;

  const latestChunkAddendum = latestChunk
    ? `\n\nLATEST TRANSCRIPT CHUNK (newest line, for recency weighting):\n${latestChunk}`
    : "";

  const prompt = `${hydratedTemplate}${appendedContext}${latestChunkAddendum}`;

  return {
    prompt,
    recentTranscript,
    rollingSummary: summaryBlock,
    previousSuggestionsBlock,
    chatFocusBlock,
    avoidPhrasesBlock,
  };
};
