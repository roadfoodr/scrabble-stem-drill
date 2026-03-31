# Scrabble Bingo Stem Drill

A voice-interactive drill for competitive Scrabble players. Given a 6-letter stem plus a letter, recall all valid 7-letter bingo words in that bucket -- entirely hands-free.

Powered by [Gemini 3.1 Flash Live](https://ai.google.dev/gemini-api/docs/multimodal-live) for real-time conversational voice, with native Web Speech API fallback for offline use.

## How it works

1. Tap **Start** -- Gemini announces a stem + letter (e.g. "TISANE plus G")
2. Say all the bingo words you can think of -- one at a time or several in a row
3. Gemini confirms each word, tells you how many remain, and auto-advances when you find them all
4. Say **hint** for progressive help, **skip** to move on, **repeat** to hear the prompt again
5. Tap **Pause** to tear down the session; **Resume** picks up where you left off

## Stems included

- **TISANE** (A-Z, 22 letters)
- **SATIRE** (18 letters)
- **RETINA** (17 letters)

~150 bingo words total, presented in shuffled order.

## Architecture

```
iPhone Safari  -->  Cloudflare Pages Function (/ws)  -->  Gemini Live API
                    (WebSocket proxy + API key)
```

- Static HTML/JS/CSS served by Cloudflare Pages (no build step)
- `functions/ws.js` proxies WebSocket audio bidirectionally and injects the API key server-side
- Client captures mic audio as PCM 16kHz, streams to Gemini, plays back 24kHz audio responses
- Falls back to native Web Speech APIs with fuzzy matching when offline

## Setup

1. Clone this repo
2. Create a [Google AI Studio](https://aistudio.google.com/apikey) API key with Gemini Live access
3. Deploy to Cloudflare Pages (no build command, output directory is `/`)
4. Set the secret: `wrangler pages secret put GEMINI_API_KEY --project-name <your-project>`
5. Open on your phone and tap Start

See [PLANNING/deployment-guide.md](PLANNING/deployment-guide.md) for detailed instructions.

## Local debugging

You can exercise the same `/ws` Pages Function locally without redeploying:

1. Copy `.dev.vars.example` to `.dev.vars`
2. Put your real `GEMINI_API_KEY` in `.dev.vars`
3. Run `npx wrangler pages dev .`
4. Open `http://127.0.0.1:8788/debug/ws-debug` for a text-only socket probe, or `http://127.0.0.1:8788/` for the full app

The debug page strips out mic/audio complexity and logs every frame, which makes it much easier to tell whether the proxy itself is failing.

Both the main app and debug page also accept `?ws=wss://...` so you can point them at a standalone Worker or another proxy host without changing code. See [PLANNING/local-debug.md](PLANNING/local-debug.md) for the full workflow and the runtime decision rule.

## Project structure

```
index.html              Entry point
debug/
  ws-debug.html         Local text-only WS debug page
  ws-debug.js           Text-only WebSocket probe UI
js/
  main.js               Orchestration and UI
  data.js               Stem/letter/word data
  state.js              Drill state management
  system-prompt.js      Gemini system prompt builder
  gemini-session.js     WebSocket + Gemini Live protocol
  audio-capture.js      Mic -> PCM 16kHz
  audio-playback.js     PCM 24kHz -> speaker
  offline-fallback.js   Native Web Speech fallback
  fuzzy-match.js        Levenshtein matching
functions/
  ws.js                 Cloudflare Pages Function (WS proxy)
word-drill.html         Original v1 prototype (reference)
PLANNING/               Design docs and deployment guide
```

## Offline mode

When Gemini is unavailable, the app automatically switches to native browser speech APIs with:
- Automatic mic re-open after each response (no button taps)
- Fuzzy matching against the known word set (Levenshtein distance <= 2)
- Batch input parsing (say multiple words, each evaluated independently)
