import type { SettingsConfig, Suggestion } from "@/lib/types";

// Compact live-suggestions prompt (~500 tokens in the static block).
// Dynamic context is placed LAST for Groq prefix-caching efficiency.
const LIVE_SUGGESTIONS_PROMPT = `You are a live meeting copilot generating 3 high-leverage suggestions the user should say, ask, or verify right now.

## Silent reasoning (do internally)
1. Infer meeting_type: sales | technical | interview | brainstorm | standup | 1-on-1 | casual.
2. Infer conversation_stage: opening | exploring | deciding | closing.
3. Pick exactly 3 moments from the verbatim recent block worth acting on.

## Selection heuristics
- Specific over general: name a person, metric, claim, or entity from the transcript.
- Mix forward-looking (what to say next) and backward-looking (respond to what was said).
- Each preview MUST quote or reference an actual phrase from the verbatim recent block.
- Use at least 2 distinct suggestion types per batch.
- Never repeat topics already covered in the avoid-phrases list.

## Anti-patterns — never do this
- No generic advice: "You could ask for more details," "Consider taking notes."
- No suggestions requiring information that is not in the transcript or general knowledge.
- No restating what was literally just said without adding value.
- No fabricated names, prices, dates, metrics, capabilities, or commitments.
- No abstract nouns like "strategy," "approach," "synergy," "best practices" unless they appear verbatim in the transcript.
- If an exact fact is missing, frame it as a question or template — do not invent it.

## Golden contrast
❌ "Consider discussing the team's approach to scaling."
✓ "Push back on the claim that 10K QPS needs Kafka — Redis Streams handles that with less ops."
❌ "You might want to verify that number."
✓ "Fact-check: they said churn dropped 40% after onboarding changes — ask for the exact cohort and timeframe."
❌ "Bring up a talking point about the project timeline."
✓ "The June 15 launch date assumes the vendor API is live by May 1 — ask if that's confirmed or estimated."
❌ "Maybe suggest an answer about the budget."
✓ "Answer: at their stated 50K MAU, the usage-based tier costs ~$1,200/mo — well under Amy's $2K ceiling."

## Quality bar
- preview: ≤25 words, self-contained, delivers value even if never clicked.
- full_content: 70–140 words. 1-sentence intro, 2-3 sentences of substance, optional next-step.
- evidence_quote: required, ≤10 words copied verbatim from the verbatim recent block.
- trigger: 1 sentence naming what in the transcript motivated this suggestion.

## Output format — strict JSON, no markdown, no commentary
{
  "meta": { "meeting_type": "string", "conversation_stage": "string" },
  "suggestions": [
    { "type": "question|talking_point|answer|fact_check|clarification", "preview": "...", "full_content": "...", "evidence_quote": "...", "trigger": "..." },
    { "type": "...", "preview": "...", "full_content": "...", "evidence_quote": "...", "trigger": "..." },
    { "type": "...", "preview": "...", "full_content": "...", "evidence_quote": "...", "trigger": "..." }
  ]
}

## Rolling summary
{rolling_summary}

## Verbatim recent (last ~90s)
{verbatim_recent}

## Chat focus
{chat_focus}

## Avoid phrases
{avoid_phrases}`;

export const DEFAULT_PROMPTS = {
  live_suggestions: LIVE_SUGGESTIONS_PROMPT,
  detailed_answer: `You are the user's meeting analyst. You have their full transcript. Answer grounded in what was actually said; if the transcript doesn't cover it, say so and answer from general knowledge with that caveat.

Your response must follow this structure:
1. Start with a single-sentence direct answer.
2. Then give short bullets or short paragraphs with the specific reasoning, evidence, or tradeoffs.
3. When referencing the transcript, cite it as [HH:MM] "quoted phrase".
4. End with "Consider asking:" followed by 1-2 useful follow-up prompts if that would help.

Quality bar:
- Length: 100-400 words unless the user explicitly asks for more.
- If the transcript contradicts the user's assumption, gently note it with a quote.
- If the transcript contains an open question, concern, or unknown, keep it unresolved unless the transcript explicitly answers it.
- If the transcript does not contain an exact price, name, commitment, timeline, or fact, say that clearly instead of inventing it.
- Use confident, structured language, but do not overclaim.

Few-shot example:
User clicked a fact-check suggestion: "Fact-check whether the outage was caused by infrastructure scale."
Answer:
Not exactly — based on the meeting, the team described the outage as a configuration issue rather than a pure scale failure. [20:39] "The outage followed the config push, not the traffic spike."

- The transcript points to deployment timing as the immediate trigger, not raw volume. [20:39] "config push"
- There is still some uncertainty around why safeguards failed, so that part should be framed as unresolved rather than settled. [20:40] "we still need the rollback audit"
- If you want to answer live, say: "From what we've said so far, this looks more like a bad config release than a capacity ceiling, but we still need the rollback audit to confirm root cause."

Consider asking:
- "What evidence do we have that traffic volume was normal at the time?"
- "Do we know why the rollback protections did not catch the bad config?"

Meeting transcript:
{full_transcript}

Previous chat history:
{chat_history}

User's question or topic of interest:
{user_query}`,
  chat: `You are the user's meeting analyst. You have their full transcript. Answer grounded in what was actually said; if the transcript doesn't cover it, say so and answer from general knowledge with that caveat.

Your response must follow this structure:
1. Start with a single-sentence direct answer.
2. Then give short bullets or short paragraphs with specifics.
3. When referencing the transcript, cite it as [HH:MM] "quoted phrase".
4. End with "Consider asking:" followed by 1-2 useful follow-up prompts if that would help.

Quality bar:
- Length: 100-400 words unless the user explicitly asks for more.
- If the transcript contradicts the user's assumption, gently note it with a quote.
- If the transcript contains an open question, concern, or unknown, keep it unresolved unless the transcript explicitly answers it.
- If the transcript does not contain an exact price, name, commitment, timeline, or fact, say that clearly instead of inventing it.
- Use confident, structured language, but do not overclaim.

Few-shot example:
User clicked a fact-check suggestion: "Fact-check whether the outage was caused by infrastructure scale."
Answer:
Not exactly — based on the meeting, the team described the outage as a configuration issue rather than a pure scale failure. [20:39] "The outage followed the config push, not the traffic spike."

- The transcript points to deployment timing as the immediate trigger, not raw volume. [20:39] "config push"
- There is still some uncertainty around why safeguards failed, so that part should be framed as unresolved rather than settled. [20:40] "we still need the rollback audit"
- If you want to answer live, say: "From what we've said so far, this looks more like a bad config release than a capacity ceiling, but we still need the rollback audit to confirm root cause."

Consider asking:
- "What evidence do we have that traffic volume was normal at the time?"
- "Do we know why the rollback protections did not catch the bad config?"

Transcript so far:
{full_transcript}

Previous chat history (for context):
{chat_history}

User's question:
{user_message}`,
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
  previousSuggestions?: Suggestion[];
  promptTemplate?: string;
  transcriptChunk: string;
};

const FALLBACK_VERBATIM = "No verbatim transcript is available yet — the meeting may have just started.";
const FALLBACK_SUMMARY = "(no prior meeting summary yet — treat the verbatim block as the full context)";
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
  "{chat_focus}",
  "{avoid_phrases}",
  "{recent_transcript}", // legacy placeholder kept for backward compatibility
] as const;

const replacePlaceholder = (template: string, placeholder: string, value: string) =>
  template.includes(placeholder) ? template.split(placeholder).join(value) : template;

// Live suggestions are assembled from four named context blocks:
//   1. rolling_summary  — compact memory of the older conversation
//   2. verbatim_recent  — what actually just happened (primary signal)
//   3. chat_focus       — what the user is actively asking about in chat
//   4. avoid_phrases    — explicit near-duplicates detected client-side after
//                         the first generation, used only on a one-shot retry
export const buildSuggestionsPrompt = ({
  contextWindow,
  fullTranscript,
  verbatimRecent,
  rollingSummary,
  recentChatTopics,
  avoidPhrases,
  promptTemplate,
  transcriptChunk,
}: BuildSuggestionsPromptParams) => {
  const normalizedVerbatim = (verbatimRecent?.trim() || "").length > 0
    ? verbatimRecent!.trim()
    : trimTextToContextWindow(fullTranscript, contextWindow);
  const recentTranscript = normalizedVerbatim || FALLBACK_VERBATIM;
  const summaryBlock = rollingSummary?.trim() || FALLBACK_SUMMARY;
  const chatFocusBlock = recentChatTopics?.trim() || FALLBACK_CHAT_FOCUS;
  const avoidPhrasesBlock = formatAvoidPhrases(avoidPhrases);
  const latestChunk = transcriptChunk.trim();

  const baseTemplate = promptTemplate?.trim() || DEFAULT_PROMPTS.live_suggestions;

  let hydratedTemplate = baseTemplate;
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{rolling_summary}", summaryBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{verbatim_recent}", recentTranscript);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{chat_focus}", chatFocusBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{avoid_phrases}", avoidPhrasesBlock);
  // Legacy single-window placeholder from the earlier implementation.
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{recent_transcript}", recentTranscript);

  const templateHasAnyPlaceholder = PLACEHOLDERS.some((placeholder) => baseTemplate.includes(placeholder));

  // If the user's custom template removed all the placeholders, append the
  // structured context blocks so nothing silently drops out of the prompt.
  const appendedContext = templateHasAnyPlaceholder
    ? ""
    : `\n\n## Rolling summary\n${summaryBlock}\n\n## Verbatim recent (last ~90s)\n${recentTranscript}\n\n## Chat focus\n${chatFocusBlock}\n\n## Avoid phrases\n${avoidPhrasesBlock}`;

  const latestChunkAddendum = latestChunk
    ? `\n\nLATEST TRANSCRIPT CHUNK (newest line, for recency weighting):\n${latestChunk}`
    : "";

  const prompt = `${hydratedTemplate}${appendedContext}${latestChunkAddendum}`;

  return {
    prompt,
    recentTranscript,
    rollingSummary: summaryBlock,
    chatFocusBlock,
    avoidPhrasesBlock,
  };
};
