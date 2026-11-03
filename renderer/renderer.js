'use strict';

const $ = (id) => document.getElementById(id);
const TURN_MERGE_MS = 220; // merge adjacent finalized speech fragments into one conversational turn
const PCM_RATE = 16000;
const PCM_PACKET_SAMPLES = 1600; // 100ms at 16kHz, recommended for Gemini Live
const MAX_TRANSCRIPT_EVENTS = 80;
const MAX_TRANSCRIPT_EVENT_CHARS = 1500;
const MAX_RETAINED_TRANSCRIPT_CHARS = 12000;
const MAX_DISPLAYED_ANSWERS = 30;

let stream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let muteNode = null;
let running = false;
let auto = true;
let answerRun = 0;
let brief = { goal: '', context: '', style: '', reminders: '' };
let meetingStart = Date.now();
let timers = [];
let turnTimer = null;
let interimText = '';
let events = [];
let surfaced = new Set();
let priorSuggestions = [];
let starting = false;
let activeAnswer = null;

const stamp = () => {
  const seconds = Math.floor((Date.now() - meetingStart) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('dot').className = cls;
}

function idle() {
  if (running) setStatus(`Listening · auto ${auto ? 'on' : 'off'}`, 'live');
  else setStatus('Paused', '');
}

function renderHeard() {
  const root = $('heard');
  root.replaceChildren();
  for (const event of events.filter((item) => item.type === 'them').slice(-3)) {
    const line = document.createElement('div');
    const label = document.createElement('b');
    label.textContent = 'Them: ';
    line.append(label, document.createTextNode(event.text));
    root.append(line);
  }
  if (interimText) {
    const line = document.createElement('div');
    line.className = 'interim';
    const label = document.createElement('b');
    label.textContent = 'Hearing: ';
    line.append(label, document.createTextNode(interimText));
    root.append(line);
  }
}

function addRemind(text) {
  if (!text || surfaced.has(text)) return;
  surfaced.add(text);
  const chip = document.createElement('div');
  chip.className = 'chip';
  chip.textContent = text;
  $('remind').append(chip);
  while ($('remind').children.length > 4) $('remind').firstElementChild.remove();
}

function addReminders(items) {
  (Array.isArray(items) ? items : []).forEach(addRemind);
}

function cancelPendingAnswer(reason) {
  // The main process handles { cancel: true } on the already exposed answer IPC.
  // Catch asynchronously so a closing window cannot create an unhandled rejection.
  try {
    const pending = window.api.answer({ cancel: true, reason });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {}
}

function clearAnswerHistory() {
  activeAnswer = null;
  $('answers').replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'Suggested replies will appear here.';
  $('answers').append(empty);
}

function finishActiveAnswer(label) {
  if (!activeAnswer) return;
  if (activeAnswer.entry.classList.contains('pending')) {
    activeAnswer.entry.remove();
  } else {
    activeAnswer.meta.textContent = `${label} · ${stamp()}`;
  }
  activeAnswer = null;
  if (!$('answers').children.length) clearAnswerHistory();
}

function beginAnswer() {
  finishActiveAnswer('Interrupted reply');
  const history = $('answers');
  history.querySelector('.empty')?.remove();

  const entry = document.createElement('article');
  entry.className = 'answer-entry pending';
  const meta = document.createElement('div');
  meta.className = 'answer-meta';
  meta.textContent = `Suggested reply · ${stamp()}`;
  const text = document.createElement('div');
  text.className = 'answer-text';
  text.textContent = 'Thinking…';
  entry.append(meta, text);
  history.append(entry);
  activeAnswer = { entry, meta, text };

  // Keep the DOM bounded during long meetings.
  while (history.querySelectorAll('.answer-entry').length > MAX_DISPLAYED_ANSWERS) {
    const oldest = history.querySelector('.answer-entry');
    if (!oldest || oldest === entry) break;
    oldest.remove();
  }

  history.scrollTop = history.scrollHeight;
}

function updateAnswer(text) {
  if (!activeAnswer) beginAnswer();
  activeAnswer.text.textContent = text;
  activeAnswer.entry.classList.remove('pending');
  $('answers').scrollTop = $('answers').scrollHeight;
}

function finishAnswer() {
  finishActiveAnswer('Suggested reply');
}

function clearOutput() {
  $('remind').replaceChildren();
  clearAnswerHistory();
}

function applyBrief(nextBrief) {
  // A changed briefing invalidates any answer generated with the old context.
  cancelPendingAnswer('brief changed');
  brief = nextBrief || {};
  meetingStart = Date.now();
  timers.forEach(clearTimeout);
  timers = [];
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  events = [];
  surfaced.clear();
  priorSuggestions = [];
  interimText = '';
  answerRun += 1;
  renderHeard();
  clearOutput();

  (brief.reminders || '').split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const match = line.match(/^@(\d+)\s*m?\s*[:\-]?\s*(.+)$/i);
    if (match) timers.push(setTimeout(() => addRemind(match[2]), Number(match[1]) * 60000));
  });
}

setInterval(() => {
  const seconds = Math.floor((Date.now() - meetingStart) / 1000);
  $('clock').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}, 1000);

// The worklet converts Float32 input to signed 16-bit PCM and sends 100ms packets.
// No local recording, WAV conversion, or per-sentence upload is performed.
const WORKLET_SOURCE = `
class GeminiPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packet = new Int16Array(${PCM_PACKET_SAMPLES});
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const frameCount = channels[0].length;
    for (let i = 0; i < frameCount; i++) {
      let mixed = 0;
      for (let c = 0; c < channels.length; c++) mixed += channels[c][i] || 0;
      const sample = Math.max(-1, Math.min(1, mixed / channels.length));
      this.packet[this.offset++] = sample < 0
        ? Math.round(sample * 32768)
        : Math.round(sample * 32767);
      if (this.offset === this.packet.length) {
        const completed = this.packet;
        this.port.postMessage(completed.buffer, [completed.buffer]);
        this.packet = new Int16Array(${PCM_PACKET_SAMPLES});
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('gemini-pcm-capture', GeminiPcmCapture);
`;

async function startCapture() {
  if (running || starting) return;
  starting = true;
  try {
    setStatus('Waiting for system audio…', 'busy');
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((track) => track.stop());
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) throw new Error('No system audio available. Choose the display/system-audio source.');

    audioContext = new AudioContext({ sampleRate: PCM_RATE, latencyHint: 'interactive' });
    if (audioContext.sampleRate !== PCM_RATE) {
      throw new Error(`AudioContext is ${audioContext.sampleRate}Hz; Gemini Live requires 16000Hz PCM.`);
    }
    const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' });
    const moduleUrl = URL.createObjectURL(blob);
    try { await audioContext.audioWorklet.addModule(moduleUrl); }
    finally { URL.revokeObjectURL(moduleUrl); }

    workletNode = new AudioWorkletNode(audioContext, 'gemini-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    workletNode.port.onmessage = (event) => {
      if (running && event.data) window.api.liveAudio(event.data);
    };

    // Connect and authenticate before opening the audio graph, preventing a large pre-connect backlog.
    setStatus('Connecting to Gemini Live…', 'busy');
    await window.api.liveStart();

    sourceNode = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;
    sourceNode.connect(workletNode);
    workletNode.connect(muteNode);
    muteNode.connect(audioContext.destination);
    running = true;
    idle();
  } catch (error) {
    await cleanupCapture(true);
    setStatus(`Capture failed: ${error.message}`, '');
  }finally {
    starting = false;
  }
}

async function cleanupCapture(stopLive = true) {
  running = false;
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  try { workletNode?.port?.close(); } catch {}
  try { sourceNode?.disconnect(); } catch {}
  try { workletNode?.disconnect(); } catch {}
  try { muteNode?.disconnect(); } catch {}
  try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
  try { await audioContext?.close(); } catch {}
  stream = null;
  audioContext = null;
  sourceNode = null;
  workletNode = null;
  muteNode = null;
  if (stopLive) {
    try { await window.api.liveStop(); } catch {}
  }
}

async function stopCapture() {
  await cleanupCapture(true);
  idle();
}

function buildTranscript() {
  return events.map((event) => {
    if (event.type === 'you') return `[${event.t}] You (suggested by assistant; not confirmed): ${event.text}`;
    return `[${event.t}] Them: ${event.text}`;
  }).join('\n').slice(-5000);
}

function scheduleAnswer() {
  if (!auto) return;
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    turnTimer = null;
    answerNow();
  }, TURN_MERGE_MS);
}

async function answerNow(force = false) {
  if ((!auto && !force) || !events.some((event) => event.type === 'them')) return;
  const thisRun = ++answerRun;
  setStatus('Thinking…', 'busy');
  const payload = {
    transcript: buildTranscript(),
    surfaced: [...surfaced],
    priorSuggestions: priorSuggestions.slice(-4),
    minutes: Math.floor((Date.now() - meetingStart) / 60000),
  };
  let failed = false;
  try {
    const result = await window.api.answer(payload);
    if (result?.error) {
      failed = true;
      setStatus(`Gemini error: ${result.error}`, '');
    } else if (thisRun === answerRun && typeof result?.say === 'string' && result.say.trim()) {
      priorSuggestions.push(result.say.trim());
      if (priorSuggestions.length > 4) priorSuggestions.shift();
    }
  } catch (error) {
    failed = true;
    setStatus(`Answer failed: ${error.message}`, '');
  } finally {
    if (!failed && thisRun === answerRun && running && !interimText) idle();
  }
}

async function manualAnswer() {
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  await answerNow(true);
}

function addTranscriptEvent(event) {
  const safeEvent = {
    ...event,
    text: String(event?.text || '').slice(0, MAX_TRANSCRIPT_EVENT_CHARS),
  };
  events.push(safeEvent);

  // Keep both event count and retained text bounded. buildTranscript() applies
  // the smaller 5,000-character request window on top of this rolling buffer.
  let retainedChars = events.reduce((total, item) => total + (item.text?.length || 0), 0);
  while (events.length > MAX_TRANSCRIPT_EVENTS || retainedChars > MAX_RETAINED_TRANSCRIPT_CHARS) {
    const removed = events.shift();
    retainedChars -= removed?.text?.length || 0;
  }
}

function onFinalTranscript(text) {
  const finalText = String(text || '').trim();
  if (!finalText) return;
  interimText = '';
  addTranscriptEvent({ type: 'them', text: finalText, t: stamp() });
  renderHeard();
  scheduleAnswer();
}

function clearConversation() {
  cancelPendingAnswer('conversation cleared');
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  events = [];
  surfaced.clear();
  priorSuggestions = [];
  interimText = '';
  answerRun += 1;
  renderHeard();
  clearOutput();
}

window.startCapture = startCapture;

window.api.briefGet().then((saved) => {
  if (saved) applyBrief(saved);
}).catch(() => {});

window.api.onCmd((cmd, arg) => {
  if (cmd === 'ask') manualAnswer();
  if (cmd === 'brief') {
    applyBrief(arg);
    if (!running) startCapture();
  }
  if (cmd === 'clear') clearConversation();
  if (cmd === 'toggle-auto') {
    auto = !auto;
    if (!auto && turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    idle();
  }
  if (cmd === 'toggle-capture') running ? stopCapture() : startCapture();
  if (cmd === 'mode') {
    $('mode').textContent = arg ? 'interactive · drag me' : 'click-through';
    document.body.classList.toggle('interactive', !!arg);
  }
  if (cmd === 'live-status') setStatus(arg, running ? 'live' : 'busy');
  if (cmd === 'live-error') setStatus(`Gemini: ${arg}`, '');
  if (cmd === 'transcript-interim') {
    if (arg) answerRun += 1;
    interimText = String(arg || '');
    if (interimText) setStatus('Hearing the other person…', 'live');
    renderHeard();
  }
  if (cmd === 'transcript-final') onFinalTranscript(arg);
  if (cmd === 'answer-start') {
    setStatus('Generating answer…', 'busy');
    beginAnswer();
  }
  if (cmd === 'say-live') {
    updateAnswer(String(arg || ''));
  }
  if (cmd === 'remind') addReminders(arg);
  if (cmd === 'answer-cancelled') {
    finishActiveAnswer('Interrupted reply');
    if (interimText) setStatus('Hearing the other person…', 'live');
    else idle();
  }
  if (cmd === 'answer-error') {
    finishActiveAnswer('Incomplete reply');
    setStatus(`Answer failed: ${arg}`, '');
  }
  if (cmd === 'answer-done') {
    finishAnswer();
    if (running && !interimText) idle();
  }
});
