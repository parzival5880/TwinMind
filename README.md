# TwinMind

Real-time meeting copilot. Listens to live mic audio, transcribes it, surfaces 3 context-aware suggestions every 30 seconds, and turns any suggestion into a grounded deep-dive answer.

- **Deployed:** https://twinmind-two.vercel.app
- **Repo:** https://github.com/parzival5880/TwinMind
- **Get a Groq key:** https://console.groq.com

Paste a Groq key into the in-app settings drawer and the app works end-to-end.

## Stack

- Next.js 14 App Router, TypeScript, React, Tailwind
- **STT:** Groq Whisper Large v3 (15s windows, 3s overlap, browser VAD gate)
- **Large model (suggestions + chat):** `openai/gpt-oss-120b`
- **Small model (rolling summary, entity extraction, salience):** Groq `llama-3.1-8b-instant`
- **Grounding:** Tavily (session-scoped cache, per-session budget cap)
- Edge runtime on all inference routes, SSE streaming for chat

## Azure vs Groq for `gpt-oss-120b`

Same model on both providers. Same prompts. Same behavior.

Groq's free tier ran out of credits for `gpt-oss-120b` during development, so the large-model calls are routed to Azure AI Foundry where free credits were available. The prompt strategy does not change — it's the same model weights. If `AZURE_OPENAI_*` env vars are unset, the code falls back to Groq automatically (`src/lib/llm-clients.ts`). Whisper and the 8B helper stay on Groq either way.

To run entirely on Groq: leave the Azure env vars out, set `GROQ_API_KEY`, done.

## Setup

```bash
git clone https://github.com/parzival5880/TwinMind.git
cd TwinMind
npm install
cp .env.local.example .env.local
# Required:
#   GROQ_API_KEY=...
# Optional grounding:
#   TAVILY_API_KEY=...
#   TAVILY_ENABLED=true
#   MAX_TAVILY_SEARCHES_PER_SESSION=30
# Optional Azure routing for gpt-oss-120b:
#   AZURE_OPENAI_ENDPOINT=...
#   AZURE_OPENAI_API_KEY=...
#   AZURE_OPENAI_DEPLOYMENT=gpt-oss-120b
#   AZURE_OPENAI_API_VERSION=2024-10-21
npm run dev
```

Deploy: import the repo into Vercel, set the same env vars, ship.

## Architecture

```
[Mic] → MediaRecorder (1s slices, 15s windows, 3s overlap, VAD)
      → /api/transcribe → Groq Whisper v3
      → Transcript State + rolling summary (8B) + salience store
      → /api/suggestions (every 30s, prefetch at 28s)
          → Call A: candidate generator (gpt-oss-120b, 6 candidates)
          → Call B: critic (gpt-oss-120b, picks 3, adds conviction)
          → Tavily grounding fetched in parallel for named entities
      → Click a suggestion → /api/chat (SSE)
          → gpt-oss-120b streams a deep-dive answer
          → Tavily grounding for factual questions
      → Stop recording → /api/wrap-up → final gist rendered in Live Suggestions
```

Anchors:
- `src/lib/prompts.ts` — every prompt
- `src/lib/suggestion-pipeline.ts` — Call A → Call B orchestration
- `src/lib/grounding.ts` + `tavily-client.ts` — entity-triggered web facts
- `src/hooks/useSuggestions.ts` — 30s cadence, growth gate, skip states
- `src/app/api/chat/route.ts` — chat SSE with grounding

## Prompt strategy

The product only works if the suggestions feel timely, specific, and worth saying aloud. Everything below is in service of that.

- **Two-call suggestion pipeline.** A candidate generator proposes 6 cards with evidence quotes, a critic trims to 3, enforces type diversity, assigns a `conviction` tier, and kills paraphrase fact-checks. One model, two passes, better honesty than a single generation could reach.
- **Meeting-type + stage rubrics.** The generator is handed an 8-type × 6-stage rubric pair so a "discovery" moment in a sales call gets different cards than a "converging" moment in a technical review. Classification happens inside the same prompt — no extra round-trip.
- **Verbatim-recent + compressed-older split.** Last ~90s stays verbatim because that's where the next-move signal lives. Older context is compressed into a rolling summary + salience store so the model remembers decisions and open threads without eating token budget on stale wording.
- **Tavily grounding on named entities.** Products, cloud services, tech stacks, standards, and companies get a live web search before generation. Any factual claim in a card must cite `[source](URL)`. Chat deep-dives use the same grounding path so factual questions ("Amazfit Active 2 price?") don't deflect to "the transcript does not contain that."
- **Anti-pattern-heavy system prompts.** More effort goes into what the model must *not* do (hide-behind phrases, meta-narration, wind-ups, section-header templates, `**bold**` bullet scaffolding, both-sides-ism on opinion calls) than into what it should do. Meeting copilots fail in predictable ways; the prompt names those failures explicitly.
- **Growth gate for the 30s cadence.** If the transcript hasn't grown enough new speech since the last batch, the interval shows a stylized "quiet room" card instead of forcing stale suggestions. Cadence never stops.

## Tradeoffs

- **Single large model vs specialized stack:** suggestions and chat both use `gpt-oss-120b` for consistent voice. Cheaper paths existed but would have fractured tone.
- **30s cadence vs continuous:** continuous feels more live, but spikes cost, creates UI churn, and makes dedup harder. 30s is the compromise.
- **Edge runtime vs Node:** edge cuts hot-path overhead for transcribe/suggestions/chat. The cost is a tighter SDK compatibility envelope.
- **Client-side audio vs server ingest:** browser capture keeps the prototype simple but pays for it in device/browser variability.
- **No persistence:** in-memory session state avoids auth + DB + privacy scope. Refresh loses everything — fine for an eval, not for production.
- **SSE vs WebSocket:** SSE is enough for one-way chat streaming. WebSocket becomes right once transcription + suggestions + chat all need bi-directional coordination on one channel.
- **Two-call pipeline:** doubles the latency of a naive one-shot prompt. Bought back by quality of the critic pass and by prefetching at 28s for a 30s display cadence.

## Known limitations

- No speaker diarization — transcript is one merged stream.
- Suggestion cards surface as a validated batch, not token-by-token streaming.
- Transcript quality is bounded by mic + room acoustics + browser audio.
- Deep-dive answers depend on Tavily being configured for factual web claims; without it, the large model answers from training-time knowledge.

## File map

- `src/app` — pages + API routes (transcribe, suggestions, chat, summary, wrap-up, salience, classify)
- `src/components` — recorder, transcript, suggestions panel, chat panel, telemetry, toasts
- `src/hooks` — audio, suggestions, chat, rolling summary, salience, wrap-up, preferences
- `src/lib` — prompts, pipeline, Groq + Azure client factory, Tavily, VAD, types, telemetry
- `scripts/evaluate-scenarios.mjs` — offline eval harness
