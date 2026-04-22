# TwinMind

## TL;DR
- TwinMind is a real-time meeting copilot: it listens to live mic audio, transcribes it, surfaces 3 context-aware suggestions every 30 seconds, and turns suggestions into grounded chat answers.
- Stack: Next.js App Router, TypeScript, React, Tailwind, Groq Whisper Large V3, Groq `openai/gpt-oss-120b`, and `llama-3.1-8b-instant` for background summarization.
- Default setup uses Groq for all models. Optionally set `AZURE_OPENAI_*` env vars to route `gpt-oss-120b` to Azure AI Foundry during development; Whisper and the 8B helpers stay on Groq.
- Local run: clone, install, add a Groq key to `.env.local`, then `npm run dev`.
- Deployed URL: [https://twinmind-two.vercel.app](https://twinmind-two.vercel.app)
- Groq key: [https://console.groq.com](https://console.groq.com)

## Architecture

```text
[Browser Mic]
  -> MediaRecorder (1s slices -> 15s windows / 3s overlap + VAD)
  -> /api/transcribe (edge)
  -> Groq Whisper v3
  -> Transcript State
  -> /api/suggestions (edge, every 30s; prefetch starts at 28s)
  -> Groq gpt-oss-120b
  -> 3 suggestions (current implementation: validated batch + loading skeletons)
  -> Click suggestion
  -> /api/chat (edge)
  -> Groq gpt-oss-120b (SSE stream)
```

Code anchors:
- audio capture / overlap / VAD: `src/hooks/useAudio.ts`, `src/lib/vad.ts`
- transcription route: `src/app/api/transcribe/route.ts`
- suggestions route + hook: `src/app/api/suggestions/route.ts`, `src/hooks/useSuggestions.ts`
- chat SSE route + hook: `src/app/api/chat/route.ts`, `src/hooks/useChat.ts`

## Prompt Strategy

This is the most important part of the project. The quality bar is not “can the model answer?”; it is “does the answer feel timely, specific, and safe enough to trust in a live meeting?”

- Meeting-type classification stays inside the main suggestions prompt instead of becoming a separate API call. That saves one network hop and one model round-trip, but more importantly it lets the same model classify and generate from the exact same context window, which avoids drift between “what kind of meeting is this?” and “what suggestion should I give right now?”
- The prompt splits transcript context into two blocks: verbatim recent context and compressed older context. The last 90 seconds stay verbatim because recency is the strongest signal for “what should I say next,” while older context is summarized so the model remembers decisions, entities, and open questions without burning the token budget on stale wording.
- Previous suggestions are included in context because repetition is one of the fastest trust-killers in a meeting UI. The model sees recent batches plus explicit “avoid phrasing” guidance so it produces a fresh batch instead of the same question reworded three ways.
- Suggestions use `temperature: 0.6` because they need some range and type-mixing; chat uses `temperature: 0.5` because detailed answers should be more stable, more factual, and less willing to improvise.
- Few-shot examples are in the prompt because they anchor tone, structure, and the difference between a generic assistant and a meeting copilot. In practice they make the model far more likely to produce suggestions that read like “use this now” instead of “here is some abstract advice.”
- Actual prompts live in [src/lib/prompts.ts](/Users/Lucifer/Desktop/Projects/TwinMind/src/lib/prompts.ts). Prompt assembly and context injection live in [src/lib/prompts.ts](/Users/Lucifer/Desktop/Projects/TwinMind/src/lib/prompts.ts) and [src/lib/groq-client.ts](/Users/Lucifer/Desktop/Projects/TwinMind/src/lib/groq-client.ts).

## Latency Measurements

Source of truth in code:
- instrumentation: [src/lib/telemetry.ts](/Users/Lucifer/Desktop/Projects/TwinMind/src/lib/telemetry.ts)
- browser debug panel: [src/components/TelemetryPanel.tsx](/Users/Lucifer/Desktop/Projects/TwinMind/src/components/TelemetryPanel.tsx)
- enable with `?debug=1`

Latest representative local measurements:

| Metric | p50 | p95 | Source |
| --- | ---: | ---: | --- |
| Transcribe round-trip | not yet captured in a checked-in browser snapshot | not yet captured in a checked-in browser snapshot | telemetry panel exists, but a saved browser pass is still needed |
| Suggestions first-render | 2.6s | 5.1s | latest local live evaluation pass |
| Chat first-token | 1.4s | 2.1s | latest local live evaluation pass |

Measured on: Chicago, US, localhost, broadband connection. The missing transcription row is a real gap in documentation, not a hidden result.

## Tradeoffs

- Single-model vs multi-model: user-visible suggestion and chat generation both use `gpt-oss-120b` for consistency in tone and reasoning quality. Background summarization uses `llama-3.1-8b-instant` because that task is cheaper and latency-sensitive, and it does not need the full quality bar of the main model.
- 30s refresh cadence vs continuous generation: continuous suggestions would feel more “live,” but they would also spike cost, create noisy UI churn, and make dedup harder. A 30-second rhythm is a deliberate compromise: slow enough to stay stable, fast enough to still feel useful in a real meeting.
- Client-side audio vs server-side audio: browser capture avoids standing up a separate streaming media backend and keeps the prototype simple. The tradeoff is browser API variability, permission friction, and less control over device/audio normalization than a dedicated server-side media ingest stack.
- Edge runtime vs Node runtime: edge routes reduce hot-path overhead for transcription, suggestions, and chat, which matters for perceived speed. The tradeoff is a slightly tighter compatibility envelope, so anything SDK-related has to work cleanly with `fetch`-style edge execution.
- No persistence vs optional save: keeping session state in memory avoids auth, database design, and privacy questions during the prototype phase. The cost is obvious: refresh loses transcript, suggestions, and chat, which is acceptable for a prompt-engineering exercise but not for a production meeting assistant.
- SSE vs WebSocket: SSE is enough for streaming chat tokens and simpler to implement for one-way server-to-client generation. A WebSocket would be the better long-term choice once transcription, suggestions, and chat all need bi-directional real-time coordination on one persistent channel.
- Token budget per prompt: the app uses small, explicit context windows because speed and relevance both degrade when the prompt becomes a transcript dump. The tradeoff is that older nuance can be compressed away, so the summary path has to preserve the right facts, names, and unresolved questions.

## What I’d Do Next

- Speaker diarization: use AssemblyAI or `pyannote` so transcript chunks become speaker-aware instead of one merged stream. That would improve both suggestion specificity and citation quality.
- Calendar integration: preload meeting title, attendees, and recent thread context before the first spoken word. That gives the model better priors without spending transcript tokens on facts the calendar already knows.
- Per-user memory across sessions: keep lightweight memory for repeated projects, vendors, and teams. That would make short meetings much stronger because the assistant would not start cold every time.
- On-device Whisper private mode: for users who care more about privacy than accuracy or setup simplicity, local transcription is the right next mode. The tradeoff is larger client requirements and less predictable browser/device performance.
- Fine-tuned suggestion model: the long-term differentiator is not “chat with transcript,” it is suggestion timing and usefulness. A distilled or fine-tuned model for the 3-suggestion task would likely outperform a generic frontier model plus prompt alone.

## Known Limitations

- Suggestion streaming is not implemented yet; the current middle column waits for a validated full batch and uses skeleton cards during load.
- Transcript quality still depends heavily on mic quality, room noise, and browser audio behavior.
- No diarization means citations are time-grounded but not reliably speaker-grounded.
- The app expects server-side env configuration for Groq/Azure keys; if those are missing, API routes fail fast with a deployment misconfiguration error.
- The telemetry panel is real, but the README still needs a checked-in browser capture for transcription latency.

## Setup

```bash
git clone https://github.com/parzival5880/TwinMind.git
cd TwinMind
npm install
cp .env.local.example .env.local
# add GROQ_API_KEY=your_key_here
# optional grounding:
# TAVILY_API_KEY=your_tavily_key
# TAVILY_ENABLED=true
# MAX_TAVILY_SEARCHES_PER_SESSION=30
# TAVILY_TIMEOUT_MS=2000
# optional Azure large-model override:
# AZURE_OPENAI_ENDPOINT=...
# AZURE_OPENAI_API_KEY=...
# AZURE_OPENAI_API_VERSION=2024-10-21
# AZURE_OPENAI_DEPLOYMENT=gpt-oss-120b
npm run dev
# open http://localhost:3000
```

Deploy: import the repo into Vercel, set the same env vars, deploy.

## File Map

- `src/app`: App Router pages plus API routes.
- `src/components`: recorder, transcript, suggestions, chat, toasts, telemetry UI.
- `src/hooks`: client orchestration for audio, suggestions, chat, telemetry, and summary state.
- `src/lib`: prompts, Groq client, export helpers, telemetry store, VAD, shared types.
- `scripts`: evaluation harness for repeatable scenario testing.
- `public`: static assets.
- `next.config.ts`: Next.js config.
- `package.json`: scripts and dependency graph.
- `README.md`: evaluator-facing design doc.
