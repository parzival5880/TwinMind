# TwinMind - Live Suggestions Assistant

TwinMind is a real-time meeting copilot that captures microphone audio, transcribes it in short chunks, generates three context-aware suggestions every 30 seconds, and lets users expand those suggestions into detailed chat answers. The project is built as a single Next.js codebase with typed API routes, client hooks, and a responsive multi-panel UI.

**Deployed URL:** `[fill in when ready]`

## Features

- Live microphone capture with chunked recording via `MediaRecorder`
- Real-time transcription through Groq Whisper Large V3
- Automatic suggestion generation every 30 seconds when transcript context changes
- Three varied suggestions per batch with deduplication against earlier batches
- Expandable suggestion cards with grounded long-form follow-up content
- Session chat panel for direct user questions and suggestion-to-answer flow
- Persistent prompt and API key settings via browser `localStorage`
- Export full session data as JSON or human-readable text
- Responsive UI for desktop, tablet, and mobile

## Tech Stack

- Frontend: Next.js 14+ App Router, TypeScript, React, Tailwind CSS
- Backend: Next.js API Routes
- AI: Groq API (`whisper-large-v3`, `openai/gpt-oss-120b`)
- Deployment: Vercel

Note: the current workspace is running on Next.js 16 and follows the same App Router architecture requested for Next.js 14+.

## Setup

### Local Development

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Create `.env.local`:

```bash
NEXT_PUBLIC_GROQ_API_KEY=your_key_here
NEXT_PUBLIC_APP_NAME=TwinMind
```

4. Start the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000).

### Verification Commands

```bash
npx tsc --noEmit
npm run lint
npm run build
```

### Get Groq API Key

Create or manage your Groq API key in the Groq Console: [console.groq.com](https://console.groq.com)

## Prompt Strategy

### Live Suggestions

Live suggestions use a recent transcript window of roughly 2000 tokens by default. The prompt is designed to return exactly three suggestions with varied types so the UI offers breadth instead of three near-duplicates. Each batch is grounded with:

- The latest transcript window trimmed from the end for recency
- The newest transcript chunk so the model reacts to what just changed
- Previous suggestions so repeated ideas are discouraged

The response is constrained to strict JSON, validated to exactly three items, and checked for:

- unique content
- mixed types
- at least one question
- concise previews
- expanded `full_content` within the target length range

### Detailed Answers

Detailed answers use a larger context window of roughly 4000 tokens by default. When a suggestion is clicked, its preview becomes the user query and the detailed-answer prompt is used to generate a fuller response grounded in the transcript. The current implementation keeps temperature low-to-moderate to reduce drift while still allowing useful phrasing and structure.

### Chat

The chat path keeps one continuous in-memory session per page load. It injects:

- a trimmed transcript window
- the most recent chat messages for continuity
- the latest user message as the active query

Typed chat and suggestion-click answers share the same backend route and model, but they can use different prompt templates through settings.

## Architecture

### Directory Structure

```text
src/
├── app/
│   ├── api/
│   │   ├── chat/           # Detailed-answer generation route
│   │   ├── suggestions/    # Live suggestions route
│   │   └── transcribe/     # Audio transcription route
│   ├── settings/           # Full-page settings UI
│   ├── layout.tsx          # Root layout and metadata
│   └── page.tsx            # Main meeting workspace
├── components/             # UI panels, modal, buttons, recorder
├── hooks/                  # Client state and API integration hooks
├── lib/
│   ├── export.ts           # Session export helpers
│   ├── groq-client.ts      # Groq wrapper and typed error handling
│   ├── prompts.ts          # Default prompts and context helpers
│   └── types.ts            # Shared TypeScript models
└── styles/
    └── globals.css         # Global theme and responsive layout styling
```

### Data Flow

`mic -> /api/transcribe -> transcript -> /api/suggestions -> UI -> click -> /api/chat -> detailed answer`

More concretely:

1. `useAudio` records microphone input in 8-second chunks.
2. Each chunk posts to `/api/transcribe`.
3. The transcript is appended to the left panel.
4. Every 30 seconds, if the transcript changed, `useSuggestions` calls `/api/suggestions`.
5. New suggestion batches appear at the top of the middle panel.
6. Clicking a suggestion sends it into chat through `/api/chat`.
7. The right panel shows the assistant’s detailed answer in chronological order.

## Tradeoffs & Decisions

- Why Next.js: one codebase for UI and API routes, easy deployment, and minimal integration overhead.
- Why Groq: fast inference for real-time UX and strong model options for both speech and text.
- Context windows `2000 / 4000`: enough recent context to stay grounded without making every call unnecessarily expensive or slow.
- No auth: the spec is session-oriented and local-first, so browser persistence is enough for this version.
- Single text model family: simpler prompt iteration and more consistent behavior across suggestions and answers.
- 30-second refresh cadence: a practical balance between freshness and unnecessary model calls.

## Evaluation Criteria

- Live suggestion quality: grounded prompt templates, recency-aware context trimming, deduplication against previous suggestions, and strict output validation.
- Full-stack engineering: typed client hooks, typed API routes, clear error handling, export support, and a responsive UI shell.
- Code quality: shared types, isolated utilities, no `any`, prompt settings surfaced in the UI, and clean separation between client state and server calls.
- Deployment: ready for Vercel deployment. Deployed URL: `[fill in when ready]`.

## Known Limitations

- Microphone quality and browser permission behavior directly affect transcript quality.
- End-to-end latency depends on Groq API responsiveness and network quality.
- Suggestion quality improves as more meeting context accumulates.
- Session state is intentionally in-memory for transcript, suggestions, and chat; a page reload clears the live session.
- The API key is stored in browser `localStorage` for this workspace, which matches the no-auth prototype spec but is not a production security model.

## Deployment

### To Vercel

1. Push the repository to GitHub.
2. Import the repository into Vercel.
3. Set environment variables:

```bash
NEXT_PUBLIC_GROQ_API_KEY=your_key_here
NEXT_PUBLIC_APP_NAME=TwinMind
```

4. Deploy.

### Recommended Vercel Notes

- Keep the Groq key available at build and runtime.
- If you prefer not to expose the key to the client, move fully to server-side key usage and update the settings flow accordingly.
- Verify microphone access over HTTPS after deployment, since browser audio APIs are more restrictive outside localhost.
