'use strict';

const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const {
  app, BrowserWindow, globalShortcut, ipcMain, screen,
  session, desktopCapturer, safeStorage,
} = require('electron');

const dotenv = require('dotenv');
const envPaths = [
  path.join(app.getPath('userData'), '.env'),
  path.join(app.getPath('userData'), 'env'),
  path.join(path.dirname(app.getPath('exe')), '.env'),
  path.join(path.dirname(app.getPath('exe')), 'env'),
  path.join(__dirname, '.env'),
  path.join(__dirname, 'env'),
];
for (const envPath of envPaths) dotenv.config({ path: envPath });

let win;
let setupWin;
let interactive = false;

// ---------------- Local settings ----------------
const briefPath = () => path.join(app.getPath('userData'), 'briefing.json');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

const loadBrief = () => readJson(briefPath()) || {};
const loadSettings = () => readJson(settingsPath()) || {};

function encryptSecret(value) {
  if (!value) return '';
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(value).toString('base64')
    : 'raw:' + value;
}

function decryptSecret(value) {
  if (!value) return '';
  if (value.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')); }
    catch { return ''; }
  }
  return value.replace(/^raw:/, '');
}

function geminiKey() {
  return process.env.GEMINI_API_KEY || decryptSecret(loadSettings().keys?.gemini) || '';
}

function answerModel() {
  const settings = loadSettings();
  return process.env.GEMINI_MODEL || process.env.ANSWER_MODEL || settings.model || 'gemini-3.6-flash';
}

function liveSttModel() {
  return process.env.GEMINI_LIVE_STT_MODEL || 'gemini-3.5-transcribe-live';
}

function transcriptionLanguageCodes() {
  const raw = (loadSettings().language || process.env.LANGUAGE || '').trim();
  if (!raw) return [];
  const aliases = {
    en: 'en-US', ta: 'ta-IN', hi: 'hi-IN', te: 'te-IN', kn: 'kn-IN',
    ml: 'ml-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN',
    ur: 'ur-IN', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP',
  };
  return [aliases[raw.toLowerCase()] || raw];
}

// ---------------- Window helpers ----------------
function sendToRenderer(cmd, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('cmd', cmd, payload);
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 920,
    height: 1200,
    minWidth: 460,
    minHeight: 600,
    x: Math.max(0, width - 940),
    y: 20,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.setContentProtection(true);
    win.showInactive();

    // Reapply after the window is displayed.
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.setContentProtection(true);
      }
    }, 300);
  });

  win.on('show', () => {
    win.setContentProtection(true);
  });
  win.webContents.on('did-finish-load', () => {
    if (geminiKey()) win.webContents.executeJavaScript('window.startCapture && window.startCapture()', true);
    const brief = loadBrief();
    if (brief && Object.keys(brief).length) sendToRenderer('brief', brief);
  });
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus();
  setupWin = new BrowserWindow({
    width: 580,
    height: 820,
    title: 'Meeting briefing',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.setContentProtection(true);
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
}

function setInteractive(on) {
  if (!win || win.isDestroyed()) return;
  interactive = !!on;
  win.setFocusable(interactive);
  win.setIgnoreMouseEvents(!interactive, { forward: true });
  sendToRenderer('mode', interactive);
}

function nudge(dx, dy) {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

function registerShortcuts() {
  const reg = (key, callback) => globalShortcut.register(key, callback);
  reg('CommandOrControl+Shift+Space', () => {
    if (!win || win.isDestroyed()) return;
    win.isVisible() ? win.hide() : win.showInactive();
  });
  reg('CommandOrControl+Shift+Enter', () => sendToRenderer('ask'));
  reg('CommandOrControl+Shift+B', openSetup);
  reg('CommandOrControl+Shift+A', () => sendToRenderer('toggle-auto'));
  reg('CommandOrControl+Shift+S', () => sendToRenderer('toggle-capture'));
  reg('CommandOrControl+Shift+X', () => sendToRenderer('clear'));
  reg('CommandOrControl+Shift+M', () => setInteractive(!interactive));
  reg('CommandOrControl+Shift+Q', () => app.quit());
  reg('CommandOrControl+Alt+Left', () => nudge(-40, 0));
  reg('CommandOrControl+Alt+Right', () => nudge(40, 0));
  reg('CommandOrControl+Alt+Up', () => nudge(0, -40));
  reg('CommandOrControl+Alt+Down', () => nudge(0, 40));
}

// ---------------- Gemini Live transcription WebSocket ----------------
// One persistent connection receives small 16kHz PCM packets continuously.
// No per-utterance WAV files and no serial STT queue.
let liveSocket = null;
let liveSender = null;
let liveReady = false;
let liveWanted = false;
let liveGeneration = 0;
let livePendingAudio = [];
let liveReconnectTimer = null;
let liveRotationTimer = null;
let liveReconnectAttempts = 0;
let liveConnectPromise = null;
let liveConnectReject = null;
let liveSetupTimer = null;
let activeAnswerController = null;
let answerSequence = 0;

const LIVE_ROTATE_MS = 8 * 60 * 1000 + 30 * 1000; // reconnect before the documented ~10-minute session limit
const LIVE_AUDIO_QUEUE_LIMIT = 30; // 3 seconds at 100ms per packet

function cancelActiveAnswer(reason = 'new speech') {
  const controller = activeAnswerController;
  if (!controller) return false;

  // Clear the reference before aborting so a new request can start immediately.
  activeAnswerController = null;
  const safeReason = String(reason || 'cancelled').slice(0, 120);
  controller.abort(safeReason);

  // The renderer needs an explicit completion signal; otherwise its pending
  // "Thinking…" card can remain visible after an aborted fetch.
  sendToRenderer('answer-cancelled', { reason: safeReason });
  return true;
}

function sendLivePacket(packet) {
  if (!liveWanted || !packet) return;
  const buffer = Buffer.isBuffer(packet)
    ? packet
    : Buffer.from(packet.buffer || packet, packet.byteOffset || 0, packet.byteLength);

  if (liveSocket && liveReady && liveSocket.readyState === WebSocket.OPEN) {
    try {
      liveSocket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: buffer.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      }));
    } catch (error) {
      console.error('Could not send Gemini audio packet:', error.message);
      livePendingAudio.push(buffer);
    }
    return;
  }

  livePendingAudio.push(buffer);
  if (livePendingAudio.length > LIVE_AUDIO_QUEUE_LIMIT) livePendingAudio.shift();
}

function flushLiveAudioQueue(socket, generation) {
  if (generation !== liveGeneration || socket !== liveSocket || !liveReady) return;
  const pending = livePendingAudio;
  livePendingAudio = [];
  for (const buffer of pending) {
    if (socket.readyState !== WebSocket.OPEN) break;
    socket.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: buffer.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    }));
  }
}

function scheduleLiveReconnect(reason) {
  if (!liveWanted || liveReconnectTimer) return;
  console.warn('Gemini Live reconnect scheduled:', reason);
  sendToRenderer('live-status', 'Reconnecting to Gemini…');
  const delay = Math.min(1000 * (2 ** liveReconnectAttempts), 10000);
  liveReconnectAttempts += 1;
  liveReconnectTimer = setTimeout(() => {
    liveReconnectTimer = null;
    if (!liveWanted || !liveSender) return;
    connectLiveTranscriber(liveSender, true).catch((error) => {
      console.error('Gemini Live reconnect failed:', error.message);
      scheduleLiveReconnect(error.message);
    });
  }, delay);
}

function connectLiveTranscriber(sender, reconnecting = false) {
  const key = geminiKey();
  if (!key) return Promise.reject(new Error('Add a Gemini API key in Ctrl+Shift+B.'));

  // Prevent startup, reconnect and timed-rotation paths from opening competing sockets.
  if (liveConnectPromise) return liveConnectPromise;
  if (liveSocket && liveReady && liveSocket.readyState === WebSocket.OPEN) {
    liveWanted = true;
    liveSender = sender;
    return Promise.resolve(true);
  }

  liveWanted = true;
  liveSender = sender;
  liveReady = false;
  clearTimeout(liveRotationTimer);
  clearTimeout(liveReconnectTimer);
  liveReconnectTimer = null;

  const generation = ++liveGeneration;
  if (liveSocket) {
    const previous = liveSocket;
    liveSocket = null;

    // Never remove the error listener while closing a WebSocket.
    if (previous.readyState === WebSocket.CONNECTING) {
      try { previous.terminate(); } catch {}
    } else if (previous.readyState === WebSocket.OPEN) {
      try { previous.close(1000, 'Replacing Gemini Live session'); } catch {}
    }
  }

  sendToRenderer('live-status', reconnecting ? 'Refreshing Gemini connection…' : 'Connecting to Gemini…');
  const url = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(key);
  const socket = new WebSocket(url, { handshakeTimeout: 20000, perMessageDeflate: false });
  liveSocket = socket;

  let connectPromise;
  connectPromise = new Promise((resolve, reject) => {
    let settled = false;

    const settle = (error = null) => {
      if (settled) return false;
      settled = true;
      clearTimeout(liveSetupTimer);
      liveSetupTimer = null;
      if (liveConnectReject === cancelPendingConnect) liveConnectReject = null;
      if (error) reject(error);
      else resolve(true);
      return true;
    };

    const cancelPendingConnect = (error) => {
      settle(error || new Error('Gemini Live connection was stopped.'));
    };
    liveConnectReject = cancelPendingConnect;

    liveSetupTimer = setTimeout(() => {
      if (generation !== liveGeneration) return;
      const error = new Error('Timed out waiting for Gemini Live setup. Check the model/API key and try again.');
      settle(error);
      try { socket.terminate(); } catch {}
    }, 25000);

    socket.on('open', () => {
      if (generation !== liveGeneration) return;
      const setup = {
        setup: {
          model: `models/${liveSttModel()}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            mode: 'VERBATIM',
            languageCodes: transcriptionLanguageCodes(), // empty means automatic language detection
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
              prefixPaddingMs: 180,
              silenceDurationMs: 350,
            },
          },
        },
      };
      try {
        socket.send(JSON.stringify(setup));
      } catch (error) {
        settle(error);
        try { socket.terminate(); } catch {}
      }
    });

    socket.on('message', (raw) => {
      if (generation !== liveGeneration) return;
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }

      if (message.error) {
        const detail = message.error.message || 'Gemini Live returned an error.';
        sendToRenderer('live-error', detail);
        settle(new Error(detail));
        return;
      }

      if (message.setupComplete && !settled) {
        liveReady = true;
        liveReconnectAttempts = 0;
        settle();
        flushLiveAudioQueue(socket, generation);
        sendToRenderer('live-status', 'Gemini connected · listening');
        if (reconnecting) sendToRenderer('live-reconnected');

        // Rotate before the Live session limit while retaining the renderer's transcript.
        liveRotationTimer = setTimeout(() => {
          if (liveWanted && generation === liveGeneration) {
            connectLiveTranscriber(liveSender, true).catch((error) => scheduleLiveReconnect(error.message));
          }
        }, LIVE_ROTATE_MS);
      }

      const content = message.serverContent;
      if (!content) return;

      if (content.interimInputTranscription?.text) {
        // New incoming speech invalidates an answer based on an earlier turn.
        cancelActiveAnswer('new incoming speech');
        sendToRenderer('transcript-interim', content.interimInputTranscription.text);
      }

      if (content.inputTranscription?.text) {
        sendToRenderer('transcript-final', content.inputTranscription.text);
      }
    });

    socket.on('error', (error) => {
      if (generation !== liveGeneration) return;
      sendToRenderer('live-error', error.message || 'Gemini WebSocket error.');
      if (!settled) settle(error);
    });

    socket.on('close', (code, reason) => {
      if (generation !== liveGeneration) return;
      liveReady = false;
      clearTimeout(liveRotationTimer);
      if (!settled) {
        settle(new Error(`Gemini Live closed during setup (${code}): ${reason.toString()}`));
      }
      if (liveWanted) scheduleLiveReconnect(`connection closed (${code})`);
    });
  });

  liveConnectPromise = connectPromise;
  // Clear only this promise; a later connection must not be cleared by an older one.
  connectPromise.then(
    () => { if (liveConnectPromise === connectPromise) liveConnectPromise = null; },
    () => { if (liveConnectPromise === connectPromise) liveConnectPromise = null; },
  );
  return connectPromise;
}
function stopLiveTranscriber() {
  liveWanted = false;
  liveReady = false;
  liveGeneration += 1;
  clearTimeout(liveRotationTimer);
  clearTimeout(liveReconnectTimer);
  clearTimeout(liveSetupTimer);
  liveRotationTimer = null;
  liveReconnectTimer = null;
  liveSetupTimer = null;
  livePendingAudio = [];
  liveConnectPromise = null;
  cancelActiveAnswer('capture stopped');

  // Reject a pending setup so the renderer does not remain stuck awaiting live:start.
  const rejectPendingConnect = liveConnectReject;
  liveConnectReject = null;
  if (rejectPendingConnect) {
    rejectPendingConnect(new Error('Gemini Live connection stopped.'));
  }

  if (liveSocket) {
    const previous = liveSocket;
    liveSocket = null;
    if (previous.readyState === WebSocket.CONNECTING) {
      try { previous.terminate(); } catch {}
    } else if (previous.readyState === WebSocket.OPEN) {
      try { previous.close(1000, 'Stopping Gemini Live session'); } catch {}
    }
  }
}

// ---------------- Gemini Flash streaming answer generation ----------------
function topicReminders(brief) {
  return (brief.reminders || '').split('\n').map((line) => line.trim())
    .filter((line) => line && !/^@\d+/.test(line))
    .map((line) => `- ${line}`).join('\n') || '(none)';
}

function buildAnswerSystem(brief, surfaced, priorSuggestions = [], artifactMode="") {
  const alreadyShown = (surfaced || []).join(' | ') || 'none';
  const previousSuggestions = (Array.isArray(priorSuggestions) ? priorSuggestions : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(-4)
    .map((item) => `- ${item.trim().slice(0, 500)}`).join('\n') || '(none)';

  return `You are a discreet real-time meeting copilot. The audio is from the OTHER meeting participants, not the user. Write a response the user can say aloud in first person.

MEETING GOAL:
${brief.goal || '(not provided)'}

BACKGROUND:
${brief.context || '(not provided)'}

STYLE:
${brief.style || 'natural, confident, clear and explanatory'}

AVAILABLE REMINDERS (only surface when relevant; never repeat already surfaced reminders):
${topicReminders(brief)}

ALREADY SURFACED:
${alreadyShown}

PREVIOUS COPILOT SUGGESTIONS (NOT CONFIRMED AS SPOKEN):
${previousSuggestions}
Use these only to keep suggestions consistent and avoid repetition. Never assume the user actually said them or made those commitments.

CONVERSATION RULES:
- The transcript is in chronological order. Respond to the newest meaningful thing the other person said.
- Do not assume the user said any earlier assistant suggestion unless the transcript explicitly confirms it. Never invent biographical facts or commitments.
- If the other person is still forming a thought, has only paused briefly, or only says an acknowledgement/filler, do not answer yet.
- Never answer every sentence fragment as a separate question. Consider the full latest turn.

ANSWER STYLE:
- Speak like a normal Indian software engineer explaining something to another person.
- Use very simple, everyday English. Imagine explaining the idea to a 12-year-old.
- Sound natural, friendly and straightforward, not like a professor, textbook, documentation or AI chatbot.
- Use common words instead of technical or high-level vocabulary.
- Explain the idea first in simple words. Only introduce a technical term if it is actually needed.
- If you use a technical term, immediately explain what it means in everyday language.
- Prefer short sentences. One idea per sentence.
- Use simple connectors like "basically", "so", "for example", "the main thing is", and "that's why" naturally. Do not force them into every answer.
- Avoid overly polished interview language. The answer should sound like something a real person would comfortably say in a conversation.
- Do not use textbook-style definitions or memorised-sounding sentences.
- Do not unnecessarily repeat the question.
- Use practical, familiar examples whenever they help explain the idea.
- Do not make the answer childish or inaccurate. Keep the technical meaning correct while making the explanation easy.
- Never invent personal experience, projects, skills or achievements for the user.

RESPONSE LENGTH:
- Simple questions: 2-3 short sentences.
- Technical concepts: 3-4 short sentences.
- Complex questions: explain only the important steps in simple language.
- Prefer 40-80 words for normal spoken answers.
- Avoid long paragraphs and unnecessary details.
- If the question asks for code or another concrete artifact, provide the actual artifact instead of describing it.
- Never remove an important technical point just to make the answer shorter.

IMPORTANT:
- If the correct answer is unknown, say: "Let me confirm that and get back to you."
- If no reply is needed, output exactly [[NO_REPLY]].
- If useful reminders should be shown, put them after a line containing exactly ###, one reminder per line. Do not invent reminders.
- Do not output [[NO_REPLY]] when a meaningful question requires an answer.

OUTPUT: ${artifactMode
  ? 'When a concrete artifact is requested, output the complete artifact using appropriate formatting. For code, use a fenced code block with the correct language. Do not substitute an explanation for the requested artifact.'
  : 'Plain text only. No markdown, labels, JSON, or quotation marks around the answer.'
}`;
}

async function readSSE(response, onData, signal) {
  if (!response.body) throw new Error('Gemini returned an empty response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try { onData(JSON.parse(payload)); }
    catch { /* ignore malformed keep-alive or partial event */ }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function streamGeminiAnswer(sender, { transcript, surfaced = [], minutes = 0, priorSuggestions = [] }) {
  const key = geminiKey();
  if (!key) throw new Error('Add a Gemini API key in Ctrl+Shift+B.');

  cancelActiveAnswer('superseded by a newer turn');
  const controller = new AbortController();
  activeAnswerController = controller;
  const mySequence = ++answerSequence;
  const brief = loadBrief();
  const model = answerModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    // Detect explicit requests for concrete deliverables.
  const artifactMode =
    /\b(write|create|generate|implement|provide|give me|show me|post|return|build)\b[\s\S]{0,250}\b(code|function|script|class|sql|json|command|regex|query|template|program|snippet)\b/i.test(transcript || '')
    || /\b(code|function|script|class|program|snippet)\b[\s\S]{0,250}\b(write|create|generate|implement|provide|give me|show me|build)\b/i.test(transcript || '');
  const generationConfig = {
    // The prompt requests a short spoken reply; 450 tokens leaves room for
    // useful explanations without allowing unnecessarily long generations.
    maxOutputTokens: artifactMode ? 1400 : 300,
    temperature: artifactMode ? 0.15 : 0.25,
  };
  // Gemini 3 models support thinkingLevel. Leave it unspecified for other
  // model families so a model switch does not trigger an unsupported-parameter error.
  if (/^gemini-3(?:\.\d+)?-/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }
  // Detect explicit requests for concrete deliverables.

  const body = {
    systemInstruction: { parts: [{ text: buildAnswerSystem(brief, surfaced, priorSuggestions, artifactMode) }], },
    contents: [{
      role: 'user',
      parts: [{ text: `Minutes into meeting: ${minutes}\n\nCONVERSATION SO FAR:\n${transcript || '(no transcript yet)'}` }],
    }],
    generationConfig,
  };

  const requestStartedAt = Date.now();
  let firstTokenAt = null;
  let httpStatus = null;
  let outcome = 'started';
  let rawText = '';
  let lastSent = '';
  let lastEmitAt = 0;
  let timedOut = false;
  const emitPartial = () => {
    if (controller.signal.aborted || mySequence !== answerSequence) return;
    const beforeReminders = rawText.split('###')[0];
    const candidate = beforeReminders.trimStart();
    const sentinel = '[[NO_REPLY]]';
    if (!candidate || sentinel.startsWith(candidate)) return;
    if (candidate === sentinel || candidate.startsWith(sentinel)) return;
    // Throttle renderer IPC slightly while still streaming visibly.
    const now = Date.now();
    if (now - lastEmitAt < 30 && candidate.length - lastSent.length < 8) return;
    lastSent = candidate;
    lastEmitAt = now;
    sender.send('cmd', 'say-live', candidate);
  };

  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  try {
    sender.send('cmd', 'answer-start');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    httpStatus = response.status;

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `Gemini ${response.status}`);
    }

    await readSSE(response, (item) => {
      const parts = item.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.thought || typeof part.text !== 'string') continue;
        if (firstTokenAt === null && part.text.length) firstTokenAt = Date.now();
        rawText += part.text;
        emitPartial();
      }
    }, controller.signal);

    if (controller.signal.aborted || mySequence !== answerSequence) {
      outcome = 'cancelled';
      return { cancelled: true };
    }

    const [answerPart, reminderPart = ''] = rawText.split('###');
    const answer = answerPart.trim();
    let say = answer;
    if (!say || say.startsWith('[[NO_REPLY]]')) say = null;
    else sender.send('cmd', 'say-live', say);

    const remind = reminderPart.split('\n')
      .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
      .filter(Boolean);
    if (remind.length) sender.send('cmd', 'remind', remind);
    sender.send('cmd', 'answer-done');
    outcome = 'completed';
    return { say, remind };
  } catch (error) {
    if (timedOut) {
      outcome = 'timeout';
      const timeoutError = new Error('Gemini answer timed out after 45 seconds.');
      sender.send('cmd', 'answer-error', timeoutError.message);
      throw timeoutError;
    }
    if (controller.signal.aborted || error.name === 'AbortError') {
      outcome = 'cancelled';
      return { cancelled: true };
    }
    outcome = 'error';
    sender.send('cmd', 'answer-error', error.message);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (activeAnswerController === controller) activeAnswerController = null;

    // Log timing only (never the transcript, prompt, API key or generated text).
    const finishedAt = Date.now();
    console.info('[GhostOverlay] answer metrics', {
      model,
      outcome,
      httpStatus,
      totalMs: finishedAt - requestStartedAt,
      firstTokenMs: firstTokenAt === null ? null : firstTokenAt - requestStartedAt,
      outputChars: rawText.length,
    });
  }
}

// ---------------- IPC ----------------
ipcMain.handle('brief:get', () => loadBrief() || { goal: '', context: '', style: '', reminders: '' });
ipcMain.handle('brief:save', (_event, brief) => {
  fs.writeFileSync(briefPath(), JSON.stringify(brief || {}, null, 2));
  sendToRenderer('brief', brief || {});
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  return true;
});

ipcMain.handle('settings:get', () => {
  const settings = loadSettings();
  return {
    model: settings.model || '',
    language: settings.language || '',
    has: { gemini: !!geminiKey() },
  };
});

ipcMain.handle('settings:save', (_event, incoming) => {
  const settings = loadSettings();
  settings.keys = settings.keys || {};
  if (incoming?.keys?.gemini) settings.keys.gemini = encryptSecret(incoming.keys.gemini.trim());
  settings.model = (incoming?.model || '').trim();
  settings.language = (incoming?.language || '').trim();
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return true;
});

ipcMain.handle('live:start', async (event) => {
  livePendingAudio = [];
  liveReconnectAttempts = 0;
  return connectLiveTranscriber(event.sender, false);
});

ipcMain.on('live:audio', (event, pcmArrayBuffer) => {
  if (!liveWanted || !pcmArrayBuffer) return;
  try {
    const packet = Buffer.isBuffer(pcmArrayBuffer)
      ? pcmArrayBuffer
      : Buffer.from(pcmArrayBuffer);
    sendLivePacket(packet);
  } catch (error) {
    console.error('Invalid PCM packet:', error.message);
  }
});

ipcMain.handle('live:stop', () => {
  stopLiveTranscriber();
  sendToRenderer('live-status', 'Paused');
  return true;
});

ipcMain.handle('answer', async (event, payload) => {
  // Reuse the existing answer IPC channel for cancellation so preload.js does
  // not need a new exposed method.
  if (payload?.cancel) {
    const reason = String(payload.reason || 'cancelled').slice(0, 120);
    if (!cancelActiveAnswer(reason)) {
      sendToRenderer('answer-cancelled', { reason });
    }
    return { cancelled: true };
  }

  try { return await streamGeminiAnswer(event.sender, payload || {}); }
  catch (error) { return { error: error.message }; }
});

ipcMain.on('app:quit', () => app.quit());
ipcMain.on('setup:close', () => {
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
});

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    },
    { useSystemPicker: false },
  );

  createWindow();
  registerShortcuts();
  if (!Object.keys(loadBrief()).length || !geminiKey()) openSetup();
});

app.on('will-quit', () => {
  stopLiveTranscriber();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());