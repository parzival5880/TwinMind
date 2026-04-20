# Token Audit

Static analysis scope: `src/` plus env example files.  
Note: the requested `.env.example` does **not** exist in this repo. The only checked-in env example is `.env.local.example`.

## Section A — Model Inventory

### LLM / speech invocation call sites

| File | Line | Function / Route | Model string | temperature | top_p | max_tokens | response_format | stream |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| `src/lib/summary.ts` | 97 | `updateRollingSummary()` | `llama-3.1-8b-instant` | `0.1` | unset | `300` | `json_schema` strict | `false` |
| `src/lib/salience.ts` | 114 | `extractSalience()` | `llama-3.1-8b-instant` | `0.1` | unset | `450` | `json_schema` strict | `false` |
| `src/lib/classifier.ts` | 62 | `classifyMeeting()` | `llama-3.1-8b-instant` | `0.1` | unset | `60` | `json_schema` strict | `false` |
| `src/lib/grounding-audit.ts` | 78 | `auditGrounding()` | `llama-3.1-8b-instant` | `0.1` | unset | `500` | `json_schema` strict | `false` |
| `src/lib/groq-client.ts` | 189 | `transcribeAudio()` | `whisper-large-v3` | `0` | n/a | n/a | `verbose_json` | `false` |
| `src/lib/groq-client.ts` | 522 | `generateSuggestions()` | `openai/gpt-oss-120b` | `0.6` | `0.9` | `900` | `json_schema` strict | `false` |
| `src/lib/groq-client.ts` | 649 | `streamDetailedAnswer()` via `/api/chat` | `openai/gpt-oss-120b` | `0.3` | unset | `800` | `text` | `true` |
| `src/lib/groq-client.ts` | 701 | `generateDetailedAnswer()` | `openai/gpt-oss-120b` | `0.3` | unset | `800` | `text` | `false` |

### Groq client construction sites

These are not model invocations themselves, but they are the SDK construction points found by grep:

| File | Line | Site |
| --- | ---: | --- |
| `src/lib/groq-client.ts` | 94 | shared client init in `initializeGroqClient()` |
| `src/lib/groq-client.ts` | 120 | key validation client in `testGroqApiKey()` |
| `src/lib/classifier.ts` | 55 | local client in `classifyMeeting()` |
| `src/lib/salience.ts` | 98 | local client in `extractSalience()` |
| `src/lib/grounding-audit.ts` | 64 | local client in `auditGrounding()` |

### Non-model Groq API call

Not counted as an LLM call site, but it does hit Groq:

- `src/lib/groq-client.ts:127` → `validationClient.models.list()` in `testGroqApiKey()`

## Section B — Plan Conformance Check

| Planned site | Actual | Status | Notes |
| --- | --- | --- | --- |
| `src/lib/summary.ts` → `llama-3.1-8b-instant`, temp `0.1`, `260–300` max tokens | `src/lib/summary.ts:97-117` | ✅ | `300` max tokens, exact model/temp match |
| `src/lib/salience.ts` → `llama-3.1-8b-instant`, temp `0.1`, `450` max tokens | `src/lib/salience.ts:114-135` | ✅ | exact model/temp/token match |
| `src/lib/classifier.ts` → `llama-3.1-8b-instant`, temp `0.1`, `60` max tokens | `src/lib/classifier.ts:62-107` | ✅ | exact match |
| `src/lib/grounding-audit.ts` → `llama-3.1-8b-instant`, temp `0.1`, `500` max tokens, env-gated | `src/lib/grounding-audit.ts:78-128`; gated in `src/app/api/suggestions/route.ts:191-215` | ✅ | audit only fires when `process.env.STRICT_GROUNDING === "1"` |
| `src/lib/groq-client.ts` suggestions call → `openai/gpt-oss-120b`, temp `0.6`, `top_p 0.9`, `900` max tokens | `src/lib/groq-client.ts:522-551` | ✅ | exact match |
| `src/app/api/chat/route.ts` → `openai/gpt-oss-120b`, temp `0.3`, `800` max tokens | route delegates at `src/app/api/chat/route.ts:213-218`; invocation is `src/lib/groq-client.ts:649-663` | ✅ | route-level behavior resolves to the planned model config |
| `src/app/api/transcribe/route.ts` → `whisper-large-v3` or turbo | route delegates at `src/app/api/transcribe/route.ts:85-87`; invocation is `src/lib/groq-client.ts:189-203` | ✅ | uses `whisper-large-v3` |

Plan-level conclusion: no direct model-setting deviations found in the agreed call matrix.

## Section C — Context Size Caps

| Cap | Expected | Actual enforcement | Status |
| --- | --- | --- | --- |
| Verbatim recent hard-cap | `1600` chars | `src/lib/verbatim.ts:4` sets `VERBATIM_MAX_CHARS = 1600`; enforced at `src/lib/verbatim.ts:31-33` | ✅ |
| Salient memory top-K injection cap | top `8` after importance × recency sort | `src/app/api/suggestions/route.ts:119` sets `TOP_K_SALIENCE = 8`; scoring/sort at `121-137`; applied at `167-173` | ✅ |
| Rolling summary length cap | `≤120 words`, `260–300` max tokens | `src/lib/summary.ts:6` sets `300` max tokens, but no explicit `≤120 words` instruction exists in `SUMMARY_SYSTEM_PROMPT` at `19-28` | ❌ |
| Salience store size cap | `MAX_STORE_SIZE = 20` | `src/hooks/useSalienceStore.ts:24` and prune at `45-61` | ✅ |
| `previous_suggestions` removal | zero hits | `rg -n "previous_suggestions" src` returned zero matches | ✅ |
| Few-shot example size | Golden contrast present; old full blocks gone | Golden contrast exists at `src/lib/prompts.ts:232-242`; static prompt body is about `3921` chars ≈ `980` tokens by `chars/4` | ✅ with note |
| Chat context verbatim cap | `800` chars | `src/lib/prompts.ts:387` sets `CHAT_VERBATIM_MAX_CHARS = 800`; used at `487-488` | ✅ |
| `PROMPT_MAX_LENGTH` | `8000` | `src/lib/prompts.ts:352` | ✅ |

Missing cap evidence:

> `src/lib/summary.ts:19-28`  
> `You maintain a rolling narrative summary of a live meeting...`  
> There is no explicit word-budget instruction such as “keep under 120 words”.

Note on prompt bulk:

- `src/lib/prompts.ts:200` comments that the static live-suggestions block is “~500 tokens”.
- Actual current static block is about `3921` chars ≈ `980` tokens before any transcript, summary, salient-memory, or chat-focus injection.

## Section D — Cadence + Gates

### Cadence inventory

| Item | Expected | Actual | Status |
| --- | --- | --- | --- |
| Suggestion interval | `30000ms` | `src/app/page.tsx:304-306` uses `30_000` | ✅ |
| Suggestion warmup / preemptive start | `~28000ms` | `src/app/page.tsx:302-307` uses `28_000` | ✅ |
| Suggestion env override | `NEXT_PUBLIC_DEMO_CADENCE_MS` | no reads found anywhere in `src/` | ❌ |
| Salience interval | `60000ms` | `src/hooks/useSalienceStore.ts:22`, scheduled at `207-209` | ✅ |
| Salience warmup | `30000ms` | `src/hooks/useSalienceStore.ts:23`, scheduled at `203-205` | ✅ |
| Rolling summary interval | `180000ms` | `src/hooks/useRollingSummary.ts:24`, scheduled at `124-126` | ✅ |
| Rolling summary warmup | `90000ms` | `src/hooks/useRollingSummary.ts:130-132` uses `SUMMARY_UPDATE_INTERVAL_MS / 2` | ✅ |
| Classifier auto-fire | once at `~60000ms` | `src/hooks/useMeetingClassifier.ts:19` and `75-86` | ✅ |

Missing env override evidence:

> `src/app/page.tsx:301-307`  
> `const warmupId = window.setTimeout(() => {`  
> `  maybeGenerateSuggestions();`  
> `  intervalId = window.setInterval(() => {`  
> `    maybeGenerateSuggestions();`  
> `  }, 30_000);`  
> `}, 28_000);`

### Suggestion gates (`src/hooks/useSuggestions.ts`)

| Gate | Expected | Actual enforcement | Status |
| --- | --- | --- | --- |
| Silence gate | skip if new verbatim growth `< 15` words | `src/hooks/useSuggestions.ts:310-318` | ✅ |
| Change-delta gate | skip if Jaccard `> 0.8` and growth `< 30` | `src/hooks/useSuggestions.ts:320-323` | ✅ |
| 429 backoff | `60s`, then `120s`, reset on success | pre-gate at `297-300`; backoff set at `428-441`; reset at `416-420` | ✅ with note |
| Chat-inflight pause | skip tick if chat inflight | `src/hooks/useSuggestions.ts:306-308` via `pauseWhileChatInflight()` | ✅ |
| Mock mode | skip all calls if `NEXT_PUBLIC_MOCK_SUGGESTIONS === "1"` | no env read and no mock guard in file | ❌ |

429 note:

- The backoff mechanism exists, but `fetchSuggestions()` throws `new Error(...)` at `src/hooks/useSuggestions.ts:242-243`, so the numeric HTTP status is lost before the catch block checks `(caughtError as { status?: number })?.status === 429` at `431-433`.
- Practical result: the backoff still works if the server error text contains “rate limit”, but it is message-driven rather than status-driven.

Missing mock-mode evidence:

> `src/hooks/useSuggestions.ts:297-324`  
> The only preflight gates are backoff, chat-inflight pause, and transcript-growth checks. There is no `process.env.NEXT_PUBLIC_MOCK_SUGGESTIONS` branch anywhere in this hook.

## Section E — Retry & Error Handling

1. Dedup retry in `useSuggestions`
   - Single retry only.
   - Evidence: `src/hooks/useSuggestions.ts:364-390`
   - Retry count: `1`
   - Pattern: first pass runs once, then one retry with `avoid_phrases`, then fallback to the original result if retry fails.

2. Other hooks
   - `useRollingSummary` has no retry loop; it fails open and returns on non-OK or exceptions.
     - Evidence: `src/hooks/useRollingSummary.ts:91-116`
   - `useSalienceStore` has no retry loop; it fails open and returns.
     - Evidence: `src/hooks/useSalienceStore.ts:126-193`
   - `useMeetingClassifier` has no retry loop; it fails open to `"default"`.
     - Evidence: `src/hooks/useMeetingClassifier.ts:48-72`

3. `while (...)` loops touching network / Groq paths
   - `src/hooks/useChat.ts:243` → `while (true)` is an SSE reader loop over a single response stream, not an API retry loop.
   - `src/hooks/useAudio.ts:450-453` → queue-drain loop is bounded by `MAX_PARALLEL_TRANSCRIPTIONS = 2` at `src/hooks/useAudio.ts:70`.
   - Finding: no uncapped request-retry `while` loop found.

4. Timers that can trigger LLM calls

| Site | Triggers | Cleanup | Respects recording / gate state |
| --- | --- | --- | --- |
| `src/app/page.tsx:302-314` | suggestions | yes | yes, effect exits when `!isRecording`, plus backoff/chat/growth gates |
| `src/hooks/useSalienceStore.ts:203-214` | salience | yes | yes, effect exits when `!isRecording` |
| `src/hooks/useRollingSummary.ts:124-137` | rolling summary | yes | yes, effect exits when `!enabled` |
| `src/hooks/useMeetingClassifier.ts:75-86` | one-shot classifier | n/a interval-free | yes, once-only guard and duration check |
| `src/hooks/useAudio.ts:470-472` | transcribe abort timeout | yes | yes, per-request timeout only |

## Section F — Routes Enumeration

| Route file | Methods | Delegates to | `x-groq-api-key` check | Error mapping |
| --- | --- | --- | --- | --- |
| `src/app/api/chat/route.ts` | `POST` | `src/lib/groq-client.ts` → `streamDetailedAnswer()` | ✅ `src/app/api/chat/route.ts:187-190` | ✅ `APIKeyError`, `TimeoutError`, generic `ChatGenerationError` |
| `src/app/api/classify/route.ts` | `POST` | `src/lib/classifier.ts` → `classifyMeeting()` | ✅ `src/app/api/classify/route.ts:28-31` | ❌ generic only; no Groq-specific mapping |
| `src/app/api/salience/route.ts` | `POST` | `src/lib/salience.ts` → `extractSalience()` | ✅ `src/app/api/salience/route.ts:59-62` | ❌ generic only; no Groq-specific mapping |
| `src/app/api/suggestions/route.ts` | `POST` | `src/lib/groq-client.ts` → `generateSuggestions()`; optional `src/lib/grounding-audit.ts` | ✅ `src/app/api/suggestions/route.ts:139-142` | ✅ `APIKeyError`, `TimeoutError`, generic `SuggestionGenerationError` |
| `src/app/api/summary/route.ts` | `POST` | `src/lib/summary.ts` → `updateRollingSummary()` | ✅ `src/app/api/summary/route.ts:16-19` | ❌ no explicit Groq-specific mapping; fail-open to `{ summary: null }` |
| `src/app/api/transcribe/route.ts` | `POST` | `src/lib/groq-client.ts` → `transcribeAudio()` | ✅ `src/app/api/transcribe/route.ts:21-24` | ✅ `APIKeyError`, `TimeoutError`, generic `TranscriptionError` |

## Section G — Env Flags

Env file reality:

- `.env.example` is missing.
- `.env.local.example` exists and contains only:
  - `NEXT_PUBLIC_GROQ_API_KEY=`
  - `NEXT_PUBLIC_APP_NAME=TwinMind`
  - `STRICT_GROUNDING=0`

### Env inventory from code

| Env var | Default behavior when unset | Where read |
| --- | --- | --- |
| `GROQ_API_KEY` | routes fall back to `NEXT_PUBLIC_GROQ_API_KEY`; if both unset, route returns missing-key / auth failure path | `src/app/api/summary/route.ts:18`, `src/app/api/chat/route.ts:189`, `src/app/api/suggestions/route.ts:141`, `src/app/api/classify/route.ts:30`, `src/app/api/transcribe/route.ts:23`, `src/app/api/salience/route.ts:61` |
| `NEXT_PUBLIC_GROQ_API_KEY` | client settings default to empty string; routes may still use it as fallback server-side | `src/hooks/useSettings.ts:38`, `src/lib/prompts.ts:360`, plus all route fallback sites above |
| `STRICT_GROUNDING` | grounding audit disabled unless exactly `"1"` | `src/app/api/suggestions/route.ts:191` |
| `NEXT_PUBLIC_APP_NAME` | UI falls back to `"TwinMind"` | `src/components/SettingsForm.tsx:115` |
| `NEXT_PUBLIC_DEMO_CADENCE_MS` | expected override is absent; hard-coded cadence remains in effect | ❌ no reads in `src/` |
| `NEXT_PUBLIC_MOCK_SUGGESTIONS` | expected mock bypass is absent; live calls always execute | ❌ no reads in `src/` |

Env deviations:

- ❌ `.env.example` missing; only `.env.local.example` exists.
- ❌ `NEXT_PUBLIC_DEMO_CADENCE_MS` is not implemented.
- ❌ `NEXT_PUBLIC_MOCK_SUGGESTIONS` is not implemented.

## Section H — Estimated Per-Minute Token Burn

Assumptions used:

- Suggestions static prompt block is about `980` tokens from `3921 chars / 4`.
- Suggestions also inject roughly:
  - verbatim recent: `1600` chars ≈ `400` tokens
  - rolling summary: ≈ `35` tokens
  - salient memory top 8: ≈ `120` tokens
  - recent chat topics + latest chunk + framing: ≈ `85` tokens
- Chat injects `800` chars of verbatim, top `6` salient moments, last `8` chat messages, clicked suggestion, and the rolling summary.
- Salience prompt estimate assumes a moderate transcript slice plus currently open moments.
- Whisper estimate uses the implemented repeat-previous-plus-current strategy in `src/hooks/useAudio.ts:577-605`.

| Call | Model | Fires per min | Avg prompt tokens | Avg completion tokens | TPM |
| --- | --- | ---: | ---: | ---: | ---: |
| suggestions | `openai/gpt-oss-120b` | `2` | `1620` | `550` | `4340` |
| salience extract | `llama-3.1-8b-instant` | `1` | `700` | `150` | `850` |
| rolling summary | `llama-3.1-8b-instant` | `0.33` | `1075` | `80` | `381` |
| classifier | `llama-3.1-8b-instant` | `0` steady-state | `830` | `20` | `0` steady-state |
| grounding audit | `llama-3.1-8b-instant` | `2` if `STRICT_GROUNDING=1`, else `0` | `1050` | `120` | `2340` when enabled |
| chat (typical) | `openai/gpt-oss-120b` | `0.5` assumption | `1015` | `220` | `618` |
| whisper | `whisper-large-v3` | `24` requests/min steady speech | n/a | n/a | `120 audio-sec/min` |

### Per-model totals vs free-tier caps

| Model | Estimated steady-state load | Cap | Budget headroom |
| --- | ---: | ---: | ---: |
| `openai/gpt-oss-120b` | `4958 TPM` | `8000 TPM` | `+3042 TPM` |
| `llama-3.1-8b-instant` without audit | `1231 TPM` | `6000 TPM` | `+4769 TPM` |
| `llama-3.1-8b-instant` with audit | `3571 TPM` | `6000 TPM` | `+2429 TPM` |
| `whisper-large-v3` | `7200 audio-sec/hour` at continuous speech | `7200 audio-sec/hour` | `0` |

Budget conclusion:

- GPT and 8B text calls are **under** the stated free-tier TPM caps at steady state.
- Whisper is the closest leak surface: the current overlap strategy pushes continuous-speech transcription to **the cap**, not below it.
- The main ways to exceed text-model caps are transient multipliers:
  - suggestion dedup retry doubling the 120B call
  - optional grounding audit
  - repeated manual refreshes during recording

## Section I — Suspect Leaks (ranked)

1. **Suspect**: The recorder duplicates Whisper work by transcribing both the previous 5-second chunk and the current 5-second chunk on every slice after the first.
   - **Evidence**: `src/hooks/useAudio.ts:577-605`
     > `enqueueTranscriptionWindow(previousChunk);`  
     > `enqueueTranscriptionWindow(currentChunk);`
   - **Impact**: about `+60 audio-sec/min` over a non-overlapped 5-second cadence; continuous speech lands at roughly `120 audio-sec/min`, which is the full stated Whisper free-tier cap.
   - **Fix complexity**: M

2. **Suspect**: The one-shot dedup retry can double the 120B suggestions call whenever new previews are near-duplicates of recent batches.
   - **Evidence**: `src/hooks/useSuggestions.ts:364-390`
     > `if (duplicatePhrases.length > 0) {`  
     > `  payload = await fetchSuggestions({ ... avoidPhrases: duplicatePhrases ... });`
   - **Impact**: up to `+4340 TPM` on `openai/gpt-oss-120b` if every 30-second batch retries.
   - **Fix complexity**: S

3. **Suspect**: The static live-suggestions prompt block is already about 980 tokens before any transcript context is injected.
   - **Evidence**: `src/lib/prompts.ts:202-274` and measured static body size `3921 chars ≈ 980 tokens`
     > `const LIVE_SUGGESTIONS_PROMPT = \`You are a live meeting copilot...`
   - **Impact**: roughly `+960 TPM` versus the comment’s implied ~500-token target at a 2/min suggestion cadence.
   - **Fix complexity**: S

4. **Suspect**: Enabling strict grounding adds an extra 8B audit call on every suggestions batch.
   - **Evidence**: `src/app/api/suggestions/route.ts:191-215`
     > `if (process.env.STRICT_GROUNDING === "1") {`  
     > `  const auditResult = await auditGrounding(...);`
   - **Impact**: about `+2340 TPM` on `llama-3.1-8b-instant` when enabled.
   - **Fix complexity**: S

5. **Suspect**: Salience extraction sends all open moments every minute, and the store can hold 20 moments with no prompt-side top-K cap before `/api/salience`.
   - **Evidence**: `src/hooks/useSalienceStore.ts:24`, `109-136`
     > `const MAX_STORE_SIZE = 20;`  
     > `const openMoments = momentsRef.current.filter((m) => m.status === "open") ...`
   - **Impact**: roughly `+200` to `+400 TPM` on `llama-3.1-8b-instant` depending on how many open moments accumulate.
   - **Fix complexity**: S

## Section J — Verification

- Git HEAD short hash: `a0d85c2`
- Timestamp: `2026-04-18T06:11:37Z`
- Total number of LLM call sites found: `8`
- Total number of ❌ deviations found: `6`

Counted as ❌ deviations:

1. Rolling summary missing explicit `≤120 words` cap.
2. Suggestion cadence env override `NEXT_PUBLIC_DEMO_CADENCE_MS` missing.
3. Mock-mode gate `NEXT_PUBLIC_MOCK_SUGGESTIONS` missing.
4. `.env.example` missing.
5. `NEXT_PUBLIC_DEMO_CADENCE_MS` missing from env surface.
6. `NEXT_PUBLIC_MOCK_SUGGESTIONS` missing from env surface.
