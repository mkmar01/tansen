import * as store from './store.js';
import { cleanText, toChunks, estimateSeconds } from './text.js';
import { fromFile, fromUrl } from './extract.js';
import * as neural from './neural.js';

const $ = sel => document.querySelector(sel);
const synth = window.speechSynthesis;

// Apple ships joke voices that are useless for long-form listening.
const NOVELTY_VOICES = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Deranged|Hysterical|Pipe Organ)\b/;

const settings = {
  voiceURI: '',
  rate: 1,
  pitch: 1,
  accessKey: '',
  keepAwake: true,
  cpuOnly: false,
  skipLinks: true,
  ...JSON.parse(localStorage.getItem('settings') || '{}'),
};
const saveSettings = () => localStorage.setItem('settings', JSON.stringify(settings));

const player = {
  item: null,
  chunks: [],
  spans: [],
  charsBefore: [], // prefix sums of chunk lengths, for time-remaining estimates
  i: 0,
  playing: false,
  gen: 0, // bumps on every new utterance so stale speech callbacks are ignored
  utterance: null, // keep a reference or some browsers garbage-collect it mid-sentence
  wakeLock: null,
  sleepTimer: null,
  lastUserScroll: 0,
  audio: new Audio(), // plays on-device neural voices; one reused element so iOS keeps allowing playback
  neuralCache: new Map(), // `${voice}|${chunk index}` -> Promise<object URL>
};
player.audio.preservesPitch = true;

const NEURAL_LOOKAHEAD = 2; // sentences synthesized ahead of the one being played
// Tiny silent clip played on the tap itself, so iOS lets us play real audio after the model finishes loading.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';


// ---------- helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.filter(c => c != null));
  return el;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function looksLikeUrl(s) {
  return /^(https?:\/\/|www\.)\S+$/i.test(s.trim());
}

function normalizeUrl(s) {
  s = s.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return new URL(s).href;
}

// ---------- library ----------

async function addItem({ title, text, source }) {
  text = cleanText(text, settings);
  const chunks = toChunks(text);
  if (!chunks.length) throw new Error('No readable text found.');
  const item = {
    id: crypto.randomUUID(),
    title: (title?.trim() || chunks[0].text).slice(0, 120),
    source,
    text,
    createdAt: Date.now(),
    chunkCount: chunks.length,
    seconds: estimateSeconds(text.length),
  };
  await store.put(item);
  return item;
}

async function importUrl(url) {
  url = normalizeUrl(url);
  const article = await fromUrl(url, settings.accessKey);
  return addItem({ ...article, source: new URL(url).hostname.replace(/^www\./, '') });
}

async function renderLibrary() {
  const items = (await store.getAll()).sort((a, b) => b.createdAt - a.createdAt);
  $('#emptyMsg').hidden = items.length > 0;
  $('#libraryList').replaceChildren(...items.map(item => {
    const pct = Math.min(100, Math.round((100 * store.getPos(item.id)) / item.chunkCount));
    const del = async e => {
      e.stopPropagation();
      if (!confirm(`Delete “${item.title}”?`)) return;
      await store.remove(item.id);
      store.clearPos(item.id);
      renderLibrary();
    };
    return h('li', { className: 'card', onclick: () => { location.hash = `#/play/${item.id}`; } },
      h('div', { className: 'card-main' },
        h('div', { className: 'card-title' }, item.title),
        h('div', { className: 'card-meta' }, `${item.source} · ${fmtDuration(item.seconds)} · ${pct}%`)),
      h('button', { className: 'icon-btn danger', 'aria-label': 'Delete', onclick: del }, '✕'),
      h('div', { className: 'card-progress', style: `--p:${pct}%` }));
  }));
}

function showLibrary() {
  pause();
  player.item = null;
  document.body.classList.remove('in-player');
  $('#libraryView').hidden = false;
  $('#playerView').hidden = true;
  $('#controls').hidden = true;
  $('#backBtn').hidden = true;
  $('#title').textContent = 'Library';
  document.title = 'Tansen';
  renderLibrary();
}

// ---------- player ----------

function showPlayer(item) {
  pause();
  player.item = item;
  player.chunks = toChunks(item.text);
  player.charsBefore = [0];
  for (const c of player.chunks) player.charsBefore.push(player.charsBefore.at(-1) + c.text.length);
  const saved = store.getPos(item.id);
  player.i = saved < player.chunks.length ? saved : 0;

  renderReader();
  document.body.classList.add('in-player');
  $('#libraryView').hidden = true;
  $('#playerView').hidden = false;
  $('#controls').hidden = false;
  $('#backBtn').hidden = false;
  $('#title').textContent = item.title;
  document.title = item.title;
  $('#progress').max = player.chunks.length - 1;
  highlight(false);
  setupMediaSession();
}

function renderReader() {
  const frag = document.createDocumentFragment();
  let para = null;
  let prev = null;
  player.spans = player.chunks.map((c, i) => {
    if (!prev || c.p !== prev.p) para = frag.appendChild(document.createElement('p'));
    else if (c.l !== prev.l) para.append(document.createElement('br'));
    prev = c;
    const span = h('span', {}, `${c.text} `);
    span.dataset.i = i;
    para.append(span);
    return span;
  });
  $('#reader').replaceChildren(frag);
  window.scrollTo(0, 0);
}

function highlight(smooth = true) {
  document.querySelector('#reader .current')?.classList.remove('current');
  const el = player.spans[player.i];
  if (el) {
    el.classList.add('current');
    // Don't fight the user if they're scrolling around.
    if (Date.now() - player.lastUserScroll > 4000) {
      el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    }
  }
  updateProgress();
}

function updateProgress() {
  const n = player.chunks.length;
  const i = Math.min(player.i, n - 1);
  $('#progress').value = i;
  $('#posLabel').textContent = `${Math.round((100 * i) / Math.max(1, n - 1))}%`;
  const remaining = player.charsBefore[n] - player.charsBefore[i];
  $('#remainLabel').textContent = `${fmtDuration(estimateSeconds(remaining, settings.rate))} left`;
}

function currentVoice() {
  return synth.getVoices().find(v => v.voiceURI === settings.voiceURI) || null;
}

// Moves on to the next sentence once the current one has finished playing.
function advance(gen, chunk) {
  if (gen !== player.gen || !player.playing) return;
  const next = player.chunks[player.i + 1];
  const gap = next && next.p !== chunk.p ? 350 : 0; // breathe between paragraphs
  player.i++;
  store.setPos(player.item.id, player.i);
  if (next) highlight();
  setTimeout(() => {
    if (gen === player.gen && player.playing) speak();
  }, gap);
}

function speak() {
  const gen = ++player.gen;
  const chunk = player.chunks[player.i];
  if (!chunk) return finish();
  if (neural.isNeural(settings.voiceURI)) return speakNeural(gen, chunk);
  player.audio.pause();

  const u = new SpeechSynthesisUtterance(chunk.text);
  const voice = currentVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = settings.rate;
  u.pitch = settings.pitch;
  u.onend = () => advance(gen, chunk);
  u.onerror = e => {
    if (gen !== player.gen || e.error === 'interrupted' || e.error === 'canceled') return;
    if (e.error === 'not-allowed') {
      pause();
      toast('Tap play to start reading.');
      return;
    }
    console.warn('Speech error, skipping sentence:', e.error);
    u.onend();
  };
  player.utterance = u;

  // Safari drops speak() calls made right after cancel(), so give it a moment.
  if (synth.speaking || synth.pending) {
    synth.cancel();
    setTimeout(() => gen === player.gen && synth.speak(u), 80);
  } else {
    synth.speak(u);
  }
}

// ---------- on-device neural voices ----------

function neuralAudio(i) {
  const key = `${settings.voiceURI}|${i}`;
  if (!player.neuralCache.has(key)) {
    const promise = neural.synthesize(player.chunks[i].text, settings.voiceURI).then(URL.createObjectURL);
    promise.catch(() => player.neuralCache.delete(key));
    player.neuralCache.set(key, promise);
  }
  return player.neuralCache.get(key);
}

// Frees audio that has already been played (or belongs to a previously selected voice).
function pruneNeuralCache(from) {
  for (const [key, promise] of player.neuralCache) {
    const [voice, idx] = [key.slice(0, key.lastIndexOf('|')), Number(key.slice(key.lastIndexOf('|') + 1))];
    if (voice === settings.voiceURI && idx >= from) continue;
    player.neuralCache.delete(key);
    promise.then(URL.revokeObjectURL, () => {});
  }
}

function loadNeural() {
  return neural.load(p => toast(`Downloading voice… ${Math.round(p * 100)}% (one time only)`));
}

async function speakNeural(gen, chunk) {
  const audio = player.audio;
  synth.cancel();
  audio.pause();
  const i = player.i;
  try {
    await loadNeural();
    if (gen !== player.gen || !player.playing) return;
    // Queue the current sentence first, then the ones after it, so playback never waits on lookahead.
    const current = neuralAudio(i);
    for (let k = 1; k <= NEURAL_LOOKAHEAD && i + k < player.chunks.length; k++) neuralAudio(i + k);
    const url = await current;
    if (gen !== player.gen || !player.playing) return;
    pruneNeuralCache(i);
    audio.onended = () => advance(gen, chunk);
    audio.onerror = null;
    audio.src = url;
    audio.playbackRate = settings.rate;
    await audio.play();
  } catch (err) {
    if (gen !== player.gen) return;
    console.warn('Neural voice failed:', err);
    pause();
    toast(err.name === 'NotAllowedError' ? 'Tap play to start reading.' : `High-quality voice failed: ${err.message}`);
  }
}

function play() {
  if (!player.item) return;
  if (player.i >= player.chunks.length) player.i = 0;
  player.playing = true;
  updatePlayButton();
  acquireWakeLock();
  if (neural.isNeural(settings.voiceURI)) unlockAudio();
  speak();
}

// Starts the shared audio element inside the tap, before the (slow) model work begins.
function unlockAudio() {
  const a = player.audio;
  a.onended = null;
  a.src = SILENCE;
  a.play().catch(() => {});
}

function pause() {
  player.playing = false;
  player.gen++;
  synth.cancel();
  player.audio.pause();
  updatePlayButton();
  releaseWakeLock();
}

function finish() {
  pause();
  store.setPos(player.item.id, player.chunks.length); // marks it 100% in the library
  player.i = player.chunks.length;
  updateProgress();
  toast('Finished 🎉');
}

function jumpTo(i) {
  player.i = Math.max(0, Math.min(player.chunks.length - 1, i));
  store.setPos(player.item.id, player.i);
  player.lastUserScroll = 0;
  highlight();
  if (player.playing) speak();
}

function updatePlayButton() {
  // SVG elements have no `hidden` property, so toggle the attribute (styles.css hides [hidden]).
  $('#playIcon').toggleAttribute('hidden', player.playing);
  $('#pauseIcon').toggleAttribute('hidden', !player.playing);
  $('#playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: player.item.title,
    artist: player.item.source,
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  const handlers = {
    play,
    pause,
    previoustrack: () => jumpTo(player.i - 1),
    nexttrack: () => jumpTo(player.i + 1),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

async function acquireWakeLock() {
  if (!settings.keepAwake || !('wakeLock' in navigator) || player.wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    player.wakeLock = lock;
    lock.addEventListener('release', () => {
      if (player.wakeLock === lock) player.wakeLock = null;
    });
  } catch { /* denied or unsupported */ }
}

function releaseWakeLock() {
  player.wakeLock?.release();
  player.wakeLock = null;
}

// ---------- voices & settings ----------

function populateVoices() {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const rank = v => (/premium/i.test(v.name) ? 0 : /enhanced|natural|neural/i.test(v.name) ? 1 : 2);
  const all = synth.getVoices()
    .filter(v => !NOVELTY_VOICES.test(v.name))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const mine = all.filter(v => v.lang.toLowerCase().startsWith(lang));
  const other = all.filter(v => !mine.includes(v));
  const opt = v => h('option', { value: v.voiceURI }, `${v.name} (${v.lang})`);
  const sel = $('#voiceSel');
  sel.replaceChildren(
    h('option', { value: '' }, 'System default'),
    h('optgroup', { label: 'High quality (on-device AI, 90–300 MB download)' },
      ...neural.VOICES.map(v => h('option', { value: neural.PREFIX + v.id }, v.label))),
    ...mine.map(opt),
    other.length ? h('optgroup', { label: 'Other languages' }, ...other.map(opt)) : null,
  );
  sel.value = settings.voiceURI;
}

function bindSettings() {
  const dlg = $('#settingsDialog');
  $('#settingsBtn').onclick = () => {
    populateVoices();
    $('#pitchRange').value = settings.pitch;
    $('#keepAwakeChk').checked = settings.keepAwake;
    $('#skipLinksChk').checked = settings.skipLinks;
    $('#cpuOnlyChk').checked = settings.cpuOnly;
    $('#accessKeyInput').value = settings.accessKey;
    dlg.showModal();
  };
  $('#voiceSel').onchange = e => { settings.voiceURI = e.target.value; saveSettings(); };
  $('#pitchRange').oninput = e => { settings.pitch = Number(e.target.value); saveSettings(); };
  $('#keepAwakeChk').onchange = e => {
    settings.keepAwake = e.target.checked;
    saveSettings();
    if (!settings.keepAwake) releaseWakeLock();
    else if (player.playing) acquireWakeLock();
  };
  $('#cpuOnlyChk').onchange = e => {
    settings.cpuOnly = e.target.checked;
    saveSettings();
    neural.setCpuOnly(settings.cpuOnly);
  };
  $('#skipLinksChk').onchange = e => { settings.skipLinks = e.target.checked; saveSettings(); };
  $('#accessKeyInput').onchange = e => { settings.accessKey = e.target.value.trim(); saveSettings(); };
  $('#testVoiceBtn').onclick = async () => {
    pause();
    const sample = 'Hello! This is how your articles and emails will sound.';
    if (neural.isNeural(settings.voiceURI)) {
      unlockAudio();
      try {
        await loadNeural();
        toast(`Generating on ${neural.backend}… (the first sentence can take a while)`);
        const url = URL.createObjectURL(await neural.synthesize(sample, settings.voiceURI));
        const { took, seconds } = neural.lastRun;
        toast(`${neural.backend}: made ${seconds.toFixed(1)}s of audio in ${took.toFixed(1)}s`);
        player.audio.src = url;
        player.audio.playbackRate = settings.rate;
        await player.audio.play();
      } catch (err) {
        toast(`High-quality voice failed: ${err.message}`);
      }
      return;
    }
    const u = new SpeechSynthesisUtterance(sample);
    const voice = currentVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    synth.speak(u);
  };
  $('#settingsClose').onclick = () => {
    dlg.close();
    if (player.playing) speak(); // apply new voice/pitch right away
  };
}

// ---------- add dialog ----------

function bindAddDialog() {
  const dlg = $('#addDialog');
  let tab = 'paste';
  const status = (msg, isError = false) => {
    $('#addStatus').textContent = msg;
    $('#addStatus').classList.toggle('error', isError);
  };
  const selectTab = name => {
    tab = name;
    dlg.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    dlg.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== name; });
    status('');
  };

  $('#addBtn').onclick = () => {
    selectTab('paste');
    dlg.showModal();
  };
  dlg.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => selectTab(b.dataset.tab); });
  $('#addCancel').onclick = () => dlg.close();

  $('#clipBtn').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return status('Clipboard is empty.', true);
      if (looksLikeUrl(text)) {
        selectTab('url');
        $('#urlInput').value = text.trim();
      } else {
        $('#pasteText').value = text;
      }
    } catch {
      status('Clipboard access was blocked — long-press the text box and choose Paste instead.', true);
    }
  };

  $('#addSubmit').onclick = async () => {
    const btn = $('#addSubmit');
    btn.disabled = true;
    status('Preparing…');
    try {
      let item;
      if (tab === 'paste') {
        const text = $('#pasteText').value;
        if (!text.trim()) throw new Error('Paste some text first.');
        item = looksLikeUrl(text)
          ? await importUrl(text)
          : await addItem({ title: $('#pasteTitle').value, text, source: 'Pasted text' });
      } else if (tab === 'url') {
        if (!$('#urlInput').value.trim()) throw new Error('Enter a link first.');
        item = await importUrl($('#urlInput').value);
      } else {
        const file = $('#fileInput').files[0];
        if (!file) throw new Error('Choose a file first.');
        item = await addItem({ ...(await fromFile(file)), source: 'File' });
      }
      dlg.close();
      for (const id of ['#pasteTitle', '#pasteText', '#urlInput', '#fileInput']) $(id).value = '';
      status('');
      location.hash = `#/play/${item.id}`;
    } catch (err) {
      status(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- incoming content (?url=… or ?text=…&title=…) ----------
// Lets bookmarklets, iOS Shortcuts, or a browser extension hand content to the app.

async function handleIncoming() {
  const q = new URLSearchParams(location.search);
  const text = q.get('text');
  const url = q.get('url') || (text && looksLikeUrl(text) ? text.trim() : null);
  if (!url && !text) return;
  history.replaceState(null, '', location.pathname + location.hash);
  try {
    const item = url
      ? await importUrl(url)
      : await addItem({ title: q.get('title'), text, source: 'Shared' });
    location.hash = `#/play/${item.id}`;
  } catch (err) {
    toast(err.message);
  }
}

// ---------- routing & startup ----------

async function route() {
  const id = location.hash.match(/^#\/play\/(.+)$/)?.[1];
  const item = id && (await store.get(id));
  if (item) showPlayer(item);
  else showLibrary();
}

function bindPlayer() {
  $('#playBtn').onclick = () => (player.playing ? pause() : play());
  $('#prevBtn').onclick = () => jumpTo(player.i - 1);
  $('#nextBtn').onclick = () => jumpTo(player.i + 1);
  $('#progress').oninput = e => jumpTo(Number(e.target.value));
  $('#reader').onclick = e => {
    const span = e.target.closest('span[data-i]');
    if (!span) return;
    jumpTo(Number(span.dataset.i));
    if (!player.playing) play();
  };
  $('#backBtn').onclick = () => { location.hash = ''; };

  const rateSel = $('#rateSel');
  rateSel.value = String(settings.rate);
  rateSel.onchange = () => {
    settings.rate = Number(rateSel.value);
    saveSettings();
    updateProgress();
    if (!player.playing) return;
    if (neural.isNeural(settings.voiceURI)) player.audio.playbackRate = settings.rate;
    else speak();
  };

  $('#sleepSel').onchange = e => {
    clearTimeout(player.sleepTimer);
    const minutes = Number(e.target.value);
    if (!minutes) return;
    toast(`Will pause in ${minutes} minutes.`);
    player.sleepTimer = setTimeout(() => {
      pause();
      e.target.value = '0';
      toast('Sleep timer — paused.');
    }, minutes * 60_000);
  };

  for (const ev of ['touchmove', 'wheel']) {
    window.addEventListener(ev, () => { player.lastUserScroll = Date.now(); }, { passive: true });
  }

  // iOS halts speech when the app is backgrounded; pick up where we left off on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !player.playing) return;
    acquireWakeLock();
    const idle = neural.isNeural(settings.voiceURI) ? player.audio.paused : !synth.speaking;
    if (idle) speak();
  });
}

// ---------- access gate ----------
// The app stays hidden until the access key is accepted. (The key itself protects the /api/fetch endpoint
// on the server; the gate keeps the rest of the app behind it too.)

const VERIFIED_KEY = 'verifiedKey';
let locked = true;

// Resolves to 'ok', 'wrong', 'misconfigured', 'no-api' (static hosting without the server) or 'offline'.
async function checkKey(key) {
  try {
    const res = await fetch('/api/fetch?check=1', { headers: { 'x-access-key': key } });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'wrong';
    if (res.status === 404) return 'no-api';
    return 'misconfigured';
  } catch {
    return 'offline';
  }
}

function setLocked(value, message = '') {
  locked = value;
  document.body.classList.toggle('locked', value);
  if (value) {
    pause();
    $('#gateKey').value = '';
    gateStatus(message, !!message);
  }
}

const gateStatus = (msg, isError = false) => {
  $('#gateStatus').textContent = msg;
  $('#gateStatus').classList.toggle('error', isError);
};

function unlock() {
  setLocked(false);
  route().then(handleIncoming);
}

function bindGate() {
  $('#gateForm').onsubmit = async e => {
    e.preventDefault();
    const key = $('#gateKey').value.trim();
    if (!key) return;
    $('#gateSubmit').disabled = true;
    gateStatus('Checking…');
    const result = await checkKey(key);
    $('#gateSubmit').disabled = false;
    const problem = {
      wrong: 'That key isn’t right.',
      misconfigured: 'The server isn’t set up with an ACCESS_KEY yet.',
      offline: 'Can’t reach the server. Check your connection.',
    }[result];
    if (problem) return gateStatus(problem, true);
    settings.accessKey = key;
    saveSettings();
    if (result === 'ok') localStorage.setItem(VERIFIED_KEY, key);
    else toast('No server API here, so web-page import won’t work.'); // local static hosting
    unlock();
  };

  $('#lockBtn').onclick = () => {
    $('#settingsDialog').close();
    localStorage.removeItem(VERIFIED_KEY);
    settings.accessKey = '';
    saveSettings();
    setLocked(true);
  };
}

async function startGate() {
  const key = settings.accessKey;
  if (!key || localStorage.getItem(VERIFIED_KEY) !== key) return setLocked(true);
  unlock(); // verified before: open straight away, even offline
  if ((await checkKey(key)) === 'wrong') {
    localStorage.removeItem(VERIFIED_KEY);
    setLocked(true, 'Your access key was changed. Enter the new one.');
  }
}

function init() {
  neural.setCpuOnly(settings.cpuOnly);
  if (!('speechSynthesis' in window)) {
    toast('This browser can’t read text aloud.');
    return;
  }
  synth.addEventListener?.('voiceschanged', populateVoices);
  bindPlayer();
  bindAddDialog();
  bindSettings();
  window.addEventListener('hashchange', () => { if (!locked) route(); });
  bindGate();
  startGate();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

init();
