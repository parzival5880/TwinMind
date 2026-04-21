import { isLargeModelExpandedContext } from "@/lib/llm-clients";
import type {
  ContextBundle,
  RollingSummary,
  SalientMoment,
  SettingsConfig,
  Suggestion,
} from "@/lib/types";

export type RubricBlock = {
  focus: string;
  selection_heuristics: string[];
  anti_patterns: string[];
  golden_contrast: {
    bad: string;
    good: string;
  };
};

export const MEETING_TYPE_RUBRICS: Record<string, RubricBlock> = {
  sales_call: {
    focus:
      "Surface discovery questions that expose budget, authority, need, and timeline. Surface objection-prep only when the prospect signals doubt or risk, not as generic pitching.",
    selection_heuristics: [
      "Prefer open questions that reveal decision process, budget ownership, or rollout urgency.",
      "Flag any pricing, ROI, timeline, or support claim for confirmation before treating it as settled.",
      "When the prospect raises an objection, surface a concrete rebuttal or clarification they would respect.",
    ],
    anti_patterns: [
      "Never suggest closing lines or generic 'ask for the deal' prompts before buying signals exist.",
      "Never suggest features or benefits the prospect has not signaled interest in.",
    ],
    golden_contrast: {
      bad: "Ask about their needs.",
      good: "Who else needs to sign off before they can move forward with a $50K purchase?",
    },
  },
  interview: {
    focus:
      "Surface follow-ups that test depth, ownership, and tradeoff reasoning in the candidate's own examples. Keep the thread anchored to what they actually claimed, not generic interview checklists.",
    selection_heuristics: [
      "Probe vague accomplishments for concrete scope, metrics, and personal contribution.",
      "When the candidate names a tradeoff, ask what they rejected and why.",
      "Use clarification suggestions to unpack jargon, architecture choices, or ambiguous responsibility boundaries.",
    ],
    anti_patterns: [
      "Never suggest trivia or abstract brainteasers disconnected from the candidate's example.",
      "Never answer for the candidate or imply facts they did not state.",
    ],
    golden_contrast: {
      bad: "Ask about a challenge they faced.",
      good: "You said you 'stabilized the service' after launch; what specifically was breaking, and what did you personally change first?",
    },
  },
  technical_review: {
    focus:
      "Prioritize bottlenecks, failure modes, tradeoffs, and claims that can be stress-tested with specifics. Suggestions should help the user interrogate architecture decisions with operational realism, not abstract best practices.",
    selection_heuristics: [
      "Prefer prompts that name a concrete throughput claim, dependency, or scaling assumption from the transcript.",
      "Use fact-checks when someone cites vendor behavior, costs, or performance ceilings as if already proven.",
      "Offer alternatives only when they directly address the stated bottleneck or risk.",
    ],
    anti_patterns: [
      "Never suggest broad 'talk about scalability/security' advice without a named failure mode.",
      "Never recommend architecture shifts that ignore the team's stated constraints.",
    ],
    golden_contrast: {
      bad: "Discuss scaling considerations.",
      good: "They blamed websocket state in memory; ask what their p99 fanout latency is before assuming Kafka fixes the real bottleneck.",
    },
  },
  standup: {
    focus:
      "Surface blockers, dependencies, and scope ambiguity that stop progress from moving. Suggestions should tighten execution and next steps, not turn a standup into a strategy meeting.",
    selection_heuristics: [
      "Prioritize unresolved blockers, missing owners, and timeline slips hidden in status updates.",
      "Ask clarifying questions when someone names progress without naming what's still at risk.",
      "Use answer/talking-point suggestions to help the user unblock someone with a concrete next action.",
    ],
    anti_patterns: [
      "Never suggest long-form retrospectives or big-picture brainstorming during routine status updates.",
      "Never restate progress updates without converting them into a blocker or next-step question.",
    ],
    golden_contrast: {
      bad: "Ask what their status is.",
      good: "You said QA is 'waiting on backend'; ask which endpoint is blocking them and who owns the fix today.",
    },
  },
  brainstorm: {
    focus:
      "Extend the strongest emerging thread with adjacent ideas, constraints, and tests that sharpen it. Suggestions should help the group explore productively without collapsing too early into execution.",
    selection_heuristics: [
      "Prefer prompts that combine a promising idea with one missing constraint, user segment, or downside.",
      "Use clarification suggestions when the team is using fuzzy language that hides different assumptions.",
      "Offer talking points that widen the idea space only if they stay close to the current thread.",
    ],
    anti_patterns: [
      "Never force premature decisions when the group is still generating options.",
      "Never introduce unrelated idea branches just to increase variety.",
    ],
    golden_contrast: {
      bad: "Come up with more ideas.",
      good: "If the onboarding assistant is aimed at new managers, what breaks if the buyer is actually HR rather than the manager?",
    },
  },
  planning: {
    focus:
      "Turn discussion into commitments, sequencing, and dependency clarity. Suggestions should help the user expose hidden assumptions in scope, staffing, dates, and handoffs.",
    selection_heuristics: [
      "Prioritize questions that clarify critical path, ownership, and what must be true for the plan to hold.",
      "Flag dates, estimates, and resource assumptions that are being spoken as commitments without verification.",
      "Use answer suggestions when the group needs a crisp framing to compare options or lock a milestone.",
    ],
    anti_patterns: [
      "Never suggest speculative feature ideas when the discussion is already about execution planning.",
      "Never treat rough estimates as settled commitments unless the transcript confirms agreement.",
    ],
    golden_contrast: {
      bad: "Ask about the timeline.",
      good: "The June launch depends on design freeze by May 1; ask what slips first if that freeze misses by a week.",
    },
  },
  one_on_one: {
    focus:
      "Surface emotional subtext, priorities, and accountability without making the exchange feel performative. Suggestions should help the user deepen trust, clarify expectations, or resolve tension carefully.",
    selection_heuristics: [
      "Prefer questions that uncover what matters most to the other person, especially when they speak indirectly.",
      "Highlight moments where commitments, feedback, or career concerns were implied but not addressed explicitly.",
      "Use clarification suggestions to translate vague dissatisfaction into one concrete issue to discuss.",
    ],
    anti_patterns: [
      "Never turn a personal check-in into a process audit unless the other person already moved there.",
      "Never suggest confrontational framing when the transcript shows caution or vulnerability.",
    ],
    golden_contrast: {
      bad: "Ask how they are feeling.",
      good: "You said the new scope is 'a lot'; ask which part feels unsustainable so the conversation gets concrete.",
    },
  },
  default: {
    focus:
      "Default to the most specific unresolved thread in the transcript and make progress on it. Bias toward one targeted question, one concrete perspective, and one grounded fact-check when the context is mixed.",
    selection_heuristics: [
      "Name a concrete claim, number, dependency, or phrase from the transcript in every suggestion.",
      "Prefer unresolved questions and high-importance open threads over generic improvement advice.",
      "Use a fact-check only when the transcript contains a verifiable claim or assumption worth challenging.",
    ],
    anti_patterns: [
      "Never produce generic meeting advice that could fit any conversation.",
      "Never invent missing facts to make a suggestion sound more useful.",
    ],
    golden_contrast: {
      bad: "Ask for more detail.",
      good: "They said the vendor can support the migration by Friday; ask whether that is contracted or just verbal.",
    },
  },
};

export const STAGE_RUBRICS: Record<string, string> = {
  opening: "Prioritize agenda/scope clarifying questions. Avoid fact-checks — context is too thin.",
  discovery: "Prioritize probes into unstated assumptions and gaps. Mix one forward question with one backward clarification.",
  debate: "Prioritize objection handling, fact-checks on claims, concrete tradeoff probes.",
  converging: "Prioritize decision-crystallizing questions and 'what would it take to commit' framings.",
  wrap_up: "Prioritize confirmation of commitments, action items, and next-step clarity.",
  unclear: "Default posture: one specific question, one concrete fact-check.",
};

export function renderSalientMemory(moments: SalientMoment[]): string {
  if (!moments || moments.length === 0) return "(no salient moments yet)";
  return moments.map(m => {
    const mm = new Date(m.timestamp);
    const hh = String(mm.getHours()).padStart(2, "0");
    const min = String(mm.getMinutes()).padStart(2, "0");
    const ss = String(mm.getSeconds()).padStart(2, "0");
    const label = m.status === "addressed" ? " (addressed)" : "";
    return `[${m.category} · imp ${m.importance} · ${hh}:${min}:${ss}] ${m.summary}${label}`;
  }).join("\n");
}

export function renderRollingSummary(s: RollingSummary | null): string {
  if (!s) return "(summary not available)";
  return `Topic: ${s.topic}
Stance: ${s.stance}
Phase: ${s.phase} · Tone: ${s.tone}
Heard: ${s.participants_heard.length ? s.participants_heard.join(", ") : "—"}`;
}

export const CHAT_SYSTEM_PROMPT = `You are the deep-dive Q&A layer of a live meeting copilot. Users click a suggestion and expect a grounded, specific answer.

Grounding rules:
- Answers MUST reference the transcript. Quote verbatim when citing facts.
- When a salient moment is relevant, reference it by its category and timestamp, e.g. "(claim at 08:14)".
- If the user clicked a suggestion, your answer should address that suggestion's preview and respect its evidence_quote as the primary anchor.
- If the transcript does not contain enough information to answer, say so explicitly. DO NOT make up facts.

Answer style:
- 80–200 words unless the user asks for more.
- Lead with the direct answer; follow with grounding.
- No hedging filler unless genuinely uncertain.`;

// Compact live-suggestions prompt (~500 tokens in the static block).
// Dynamic context is placed LAST for Groq prefix-caching efficiency.
const LIVE_SUGGESTIONS_PROMPT = `You are a live meeting copilot generating 3 high-leverage suggestions the user should say, ask, or verify right now.

## Silent reasoning (do internally)
1. Infer meeting_type: sales_call | technical_review | interview | brainstorm | standup | planning | one_on_one | default.
2. Infer conversation_stage: opening | discovery | debate | converging | wrap_up | unclear.
3. Pick exactly 3 moments from the verbatim recent block worth acting on.

## Selection heuristics
- Specific over general: name a person, metric, claim, or entity from the transcript.
- Mix forward-looking (what to say next) and backward-looking (respond to what was said).
- Each preview MUST quote or reference an actual phrase from the verbatim recent block.
- Your batch of 3 MUST include at least 2 distinct suggestion types from { question, talking_point, answer, fact_check, clarification }. Pick based on what the transcript signals:
  - Use \`answer\` when a specific question was asked that the transcript or general knowledge can answer.
  - Use \`fact_check\` when someone stated a verifiable claim (a number, date, capability, commitment) worth confirming.
  - Use \`clarification\` when language is ambiguous and nailing the meaning unlocks progress.
  - Use \`question\` to probe the next unresolved thread.
  - Use \`talking_point\` to offer a concrete stance the user could say next.
- Never return 3 of the same type. If the transcript genuinely only supports one type right now, still pick 2 differing approaches (e.g., one question probing forward, one clarification unpacking a prior phrase).
- Never repeat topics already covered in the avoid-phrases list.
- Reference \`Salient memory\` for unresolved threads from earlier in the meeting; do not limit yourself to the last 90s.
- Prefer high-importance open items when nothing new is happening.

## Focus for this meeting type
{meeting_type_rubric}

## Current conversation stage
{conversation_stage_rubric}

## Anti-patterns — never do this
- No generic advice: "You could ask for more details," "Consider taking notes."
- No suggestions requiring information that is not in the transcript or general knowledge.
- No restating what was literally just said without adding value.
- No fabricated names, prices, dates, metrics, capabilities, or commitments.
- No abstract nouns like "strategy," "approach," "synergy," "best practices" unless they appear verbatim in the transcript.
- If an exact fact is missing, frame it as a question or template — do not invent it.
- Never write a preview that only tells the user what the card is 'about' (e.g., 'Ask about X', 'Fact-check the Y claim'). The preview must BE the question/stance/fact itself, not a label describing it.

## Golden contrast
❌ "Consider discussing the team's approach to scaling."
✓ "Push back on the claim that 10K QPS needs Kafka — Redis Streams handles that with less ops."
❌ "You might want to verify that number."
✓ "Fact-check: they said churn dropped 40% after onboarding changes — ask for the exact cohort and timeframe."
❌ "Bring up a talking point about the project timeline."
✓ "The June 15 launch date assumes the vendor API is live by May 1 — ask if that's confirmed or estimated."
❌ "Maybe suggest an answer about the budget."
✓ "Answer: at their stated 50K MAU, the usage-based tier costs ~$1,200/mo — well under Amy's $2K ceiling."
❌ why_relevant: "This matters because budget came up."
✓ why_relevant: "The quote names the launch dependency, which is the factual basis for asking whether May 1 is confirmed."
❌ preview: 'Ask about the budget concerns they mentioned.'
✓ preview: 'Ask whether the $2K ceiling Amy named includes support fees or is just licensing.'
❌ preview: 'Fact-check the scaling claim.'
✓ preview: 'Fact-check: Redis Streams at 10K QPS runs comfortably on one node — Kafka may be overkill for their load.'
❌ preview: 'Consider a clarification on their timeline.'
✓ preview: 'Clarify whether the June 15 launch means feature-complete or GA — they used both today.'

## Quality bar
- preview: ≤25 words, MUST be a complete, actionable unit of value on its own. A reader who never clicks must already gain the insight or specific prompt to say. It must name a concrete element from the transcript (a phrase, number, entity, or claim). It must not tease or promise detail that only appears in full_content. full_content exists to add depth, caveats, and phrasing options — NOT to reveal the point.
- full_content: MUST be between 70 and 140 words. Count your words before outputting. If under 70, add a concrete example or caveat. If over 140, trim the least essential sentence. This is a hard requirement. full_content extends the preview with: phrasing variants the user could say aloud, one concrete follow-up, and (if using public knowledge in the preview) the specific source or basis for that knowledge (e.g., "Discord engineering blog 2017", "AWS MSK pricing calculator"). full_content must NEVER contradict the preview.
- evidence_quote: required, ≤10 words copied verbatim from the verbatim recent block.
- why_relevant: ≤150 chars, explains HOW the evidence_quote supports the preview's claim. Must NOT restate the preview. If you cannot articulate this linkage in 20 words, the suggestion is not grounded — pick a different moment.
- trigger: 1 sentence naming what in the transcript motivated this suggestion.

## Output format — strict JSON, no markdown, no commentary
{
  "meta": { "meeting_type": "string", "conversation_stage": "string" },
  "suggestions": [
    { "type": "question|talking_point|answer|fact_check|clarification", "preview": "...", "full_content": "...", "evidence_quote": "...", "why_relevant": "...", "trigger": "..." },
    { "type": "...", "preview": "...", "full_content": "...", "evidence_quote": "...", "why_relevant": "...", "trigger": "..." },
    { "type": "...", "preview": "...", "full_content": "...", "evidence_quote": "...", "why_relevant": "...", "trigger": "..." }
  ]
}

## Salient memory (whole meeting so far)
{salient_memory}

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
  suggestions: isLargeModelExpandedContext() ? 3500 : 2000,
  answers: isLargeModelExpandedContext() ? 6000 : 4000,
};

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
  rollingSummary?: string | RollingSummary | null;
  recentChatTopics?: string;
  avoidPhrases?: string[];
  previousSuggestions?: Suggestion[];
  promptTemplate?: string;
  transcriptChunk: string;
  meetingType?: string;
  conversationStage?: string;
  salientMemoryRendered?: string;
};

const FALLBACK_VERBATIM = "No verbatim transcript is available yet — the meeting may have just started.";
const FALLBACK_SUMMARY = "(no prior meeting summary yet — treat the verbatim block as the full context)";
const FALLBACK_CHAT_FOCUS = "(the user has not asked anything in chat yet)";
const FALLBACK_AVOID_PHRASES = "(no near-duplicate phrases to avoid)";
const CHAT_VERBATIM_MAX_CHARS = 800;

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
  "{salient_memory}",
  "{rolling_summary}",
  "{verbatim_recent}",
  "{chat_focus}",
  "{avoid_phrases}",
  "{meeting_type_rubric}",
  "{conversation_stage_rubric}",
  "{recent_transcript}", // legacy placeholder kept for backward compatibility
] as const;

const replacePlaceholder = (template: string, placeholder: string, value: string) =>
  template.includes(placeholder) ? template.split(placeholder).join(value) : template;

const renderRubricBlock = (rubric: RubricBlock) =>
  `Focus:
${rubric.focus}

Selection heuristics:
- ${rubric.selection_heuristics.join("\n- ")}

Anti-patterns:
- ${rubric.anti_patterns.join("\n- ")}

Golden contrast:
Bad: ${rubric.golden_contrast.bad}
Good: ${rubric.golden_contrast.good}`;

const truncateForPrompt = (value: string, maxChars: number) => {
  const normalized = value.trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `...${normalized.slice(-(maxChars - 3))}`;
};

const renderClickedSuggestion = (suggestion?: Suggestion) => {
  if (!suggestion) {
    return "(none)";
  }

  return [
    `preview: ${suggestion.preview}`,
    `type: ${suggestion.type}`,
    `evidence_quote: ${suggestion.evidence_quote}`,
    `why_relevant: ${suggestion.why_relevant || "The user clicked this suggestion for a deeper answer."}`,
  ].join("\n");
};

export function buildChatSystemPrompt(context: ContextBundle, suggestion?: Suggestion): string {
  const expanded = isLargeModelExpandedContext();
  const rollingSummaryBlock = renderRollingSummary(context.rollingSummary);
  const salientMemoryBlock = renderSalientMemory(context.salientMemory.slice(0, expanded ? 12 : 6));
  const verbatimRecentBlock =
    truncateForPrompt(context.verbatimRecent || "(no recent verbatim available)", expanded ? 1600 : CHAT_VERBATIM_MAX_CHARS);
  const clickedSuggestionBlock = renderClickedSuggestion(suggestion);
  const meetingMetaBlock = context.meta
    ? `${context.meta.meeting_type} · ${context.meta.conversation_stage}`
    : "(not classified yet)";
  const recentChatTopicsBlock = context.recentChatTopics.length > 0
    ? context.recentChatTopics.map((topic, index) => `${index + 1}. ${topic}`).join("\n")
    : "(no recent user chat topics)";

  return `${CHAT_SYSTEM_PROMPT}

## Meeting meta
${meetingMetaBlock}

## Topic
${rollingSummaryBlock}

## Salient memory (top 6)
${salientMemoryBlock}

## Verbatim recent (last ~90s, truncated to 800 chars)
${verbatimRecentBlock}

## Recent chat topics
${recentChatTopicsBlock}

## Clicked suggestion (may be null)
${clickedSuggestionBlock}`;
}

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
  meetingType,
  conversationStage,
  salientMemoryRendered,
}: BuildSuggestionsPromptParams) => {
  const normalizedVerbatim = (verbatimRecent?.trim() || "").length > 0
    ? verbatimRecent!.trim()
    : trimTextToContextWindow(fullTranscript, contextWindow);
  const recentTranscript = normalizedVerbatim || FALLBACK_VERBATIM;
  const summaryBlock = typeof rollingSummary === "string"
    ? rollingSummary.trim() || FALLBACK_SUMMARY
    : renderRollingSummary(rollingSummary ?? null);
  const chatFocusBlock = recentChatTopics?.trim() || FALLBACK_CHAT_FOCUS;
  const avoidPhrasesBlock = formatAvoidPhrases(avoidPhrases);
  const latestChunk = transcriptChunk.trim();
  const rubricKey = meetingType && meetingType in MEETING_TYPE_RUBRICS ? meetingType : "default";
  const meetingTypeRubric = renderRubricBlock(MEETING_TYPE_RUBRICS[rubricKey]);
  const stageKey = conversationStage && conversationStage in STAGE_RUBRICS
    ? conversationStage
    : "unclear";
  const conversationStageRubric = STAGE_RUBRICS[stageKey];
  const salientMemoryBlock = salientMemoryRendered?.trim() || "(no salient moments yet)";

  const baseTemplate = promptTemplate?.trim() || DEFAULT_PROMPTS.live_suggestions;

  let hydratedTemplate = baseTemplate;
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{salient_memory}", salientMemoryBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{rolling_summary}", summaryBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{verbatim_recent}", recentTranscript);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{chat_focus}", chatFocusBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{avoid_phrases}", avoidPhrasesBlock);
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{meeting_type_rubric}", meetingTypeRubric);
  hydratedTemplate = replacePlaceholder(
    hydratedTemplate,
    "{conversation_stage_rubric}",
    conversationStageRubric,
  );
  // Legacy single-window placeholder from the earlier implementation.
  hydratedTemplate = replacePlaceholder(hydratedTemplate, "{recent_transcript}", recentTranscript);

  const templateHasAnyPlaceholder = PLACEHOLDERS.some((placeholder) => baseTemplate.includes(placeholder));

  // If the user's custom template removed all the placeholders, append the
  // structured context blocks so nothing silently drops out of the prompt.
  const appendedContext = templateHasAnyPlaceholder
    ? ""
    : `\n\n## Focus for this meeting type\n${meetingTypeRubric}\n\n## Current conversation stage\n${conversationStageRubric}\n\n## Salient memory (whole meeting so far)\n${salientMemoryBlock}\n\n## Rolling summary\n${summaryBlock}\n\n## Verbatim recent (last ~90s)\n${recentTranscript}\n\n## Chat focus\n${chatFocusBlock}\n\n## Avoid phrases\n${avoidPhrasesBlock}`;

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
