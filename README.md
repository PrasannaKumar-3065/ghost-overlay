# Ghost Overlay — Gemini Live replacement

This replacement changes the audio/answer path to:

1. Capture the Windows system-audio loopback with an AudioWorklet.
2. Convert it to 16kHz mono signed 16-bit PCM in 100ms packets.
3. Stream packets continuously over one Gemini Live WebSocket using `gemini-3.5-transcribe-live`.
4. Show interim transcript text in the overlay.
5. Collect finalized transcript fragments and merge adjacent fragments for 420ms.
6. Make one streaming Gemini Flash text-generation request for the completed conversational turn.
7. Cancel an older answer when new speech is detected or a newer turn is submitted.

## Install

1. Back up your existing project folder.
2. Replace `main.js` and `preload.js` with the files in this package.
3. Create/replace the `renderer` folder using the included `renderer/` files. The app expects:

   - `renderer/index.html`
   - `renderer/renderer.js`
   - `renderer/setup.html`
   - `renderer/style.css`

4. Merge the supplied `package.json` into your existing one if you have custom dependencies or build settings. At minimum, add `ws` to dependencies.
5. From the project root, run:

   ```bash
   npm install
   npm start
   ```

6. Enter your Gemini API key in the briefing window.

You can alternatively put `GEMINI_API_KEY` in a `.env` or `env` file. In a packaged install, put it in Electron's user-data directory (typically `%APPDATA%\<app name>\`) or beside the installed executable. The installer intentionally does not bundle your API key.

## Configuration

- Set `APP_NAME` in the project-root `.env` or `env` file before running `npm run dist` to set the installed application's product and installer name. If omitted, the build uses `Ghost Overlay`.
- `APP_NAME` also sets the Windows executable filename, which is the name shown in Task Manager. Rebuild and reinstall after changing it.
- `GEMINI_LIVE_STT_MODEL` defaults to `gemini-3.5-transcribe-live`.
- `GEMINI_MODEL` (or `ANSWER_MODEL`) defaults to `gemini-3.6-flash`.
- Each generated answer has a 1,000-token output ceiling. This is a generous cap, not a required answer length; a finite ceiling avoids unbounded response time and usage.
- Leave the language hint blank for automatic language detection.

## Overlay controls

The overlay opens at 920×1200 and can be resized. Its close button quits the app; switch to interactive mode with `Ctrl+Shift+M` before clicking it. The briefing window has its own close button.

## Important notes

- The Live Transcribe model has a documented session-duration limit of about 10 minutes. This code reconnects after 8 minutes 30 seconds. A short reconnect gap is possible.
- The transcription and answer are both Gemini, but they are two models/stages: Live Transcribe handles continuous speech recognition; Gemini Flash generates the concise answer. This is intentional because the current Gemini 3.8 Live voice-agent model uses audio as its response modality, whereas this overlay needs text output.
- This version uses server-side VAD from Gemini. It does not issue LLM calls for interim transcript updates. Final transcript fragments are coalesced for 420ms before requesting an answer.
- The UI's `setContentProtection(true)` is best-effort capture protection, not a guarantee against every screen recorder or sharing tool.
- Audio is streamed to Google's Gemini service. Obtain appropriate consent before using this in meetings/interviews.
