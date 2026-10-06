// High-quality on-device voices (Kokoro-82M). Free: the model runs in the browser, nothing is sent anywhere.
// The library loads from a CDN on first use; the model (~90 MB on CPU, ~300 MB on GPU) downloads once and is cached by the browser.

const LIB = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const PREFIX = 'kokoro:';

export const VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'af_nicole', label: 'Nicole (US, female)' },
  { id: 'af_sarah', label: 'Sarah (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
];

export const isNeural = voiceURI => voiceURI?.startsWith(PREFIX);

let ttsPromise;
let queue = Promise.resolve(); // the model handles one request at a time

async function hasWebGPU() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

// onProgress receives a 0–1 number while the model downloads.
// Uses the GPU (WebGPU, fast, ~300 MB model) when available, otherwise the CPU (WASM, slower, ~90 MB model).
export function load(onProgress) {
  ttsPromise ??= (async () => {
    const { KokoroTTS } = await import(LIB);
    const create = (device, dtype) => {
      const files = new Map();
      return KokoroTTS.from_pretrained(MODEL, {
        dtype,
        device,
        progress_callback: p => {
          if (p.status !== 'progress' || !p.total) return;
          files.set(p.file, p);
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          onProgress?.(loaded / total);
        },
      });
    };
    if (await hasWebGPU()) {
      try {
        const tts = await create('webgpu', 'fp32');
        console.info('[neural] using WebGPU');
        return tts;
      } catch (err) {
        console.warn('[neural] WebGPU failed, falling back to WASM:', err);
      }
    }
    const tts = await create('wasm', 'q8');
    console.info('[neural] using WASM (CPU)');
    return tts;
  })().catch(err => {
    ttsPromise = undefined; // allow a retry
    throw err;
  });
  return ttsPromise;
}

// Returns a WAV Blob for one chunk of text.
export function synthesize(text, voiceURI) {
  const voice = voiceURI.slice(PREFIX.length);
  const run = async () => {
    const tts = await load();
    const t0 = performance.now();
    const audio = await tts.generate(text, { voice });
    const took = (performance.now() - t0) / 1000;
    console.info(`[neural] ${took.toFixed(2)}s to make ${(audio.audio.length / audio.sampling_rate).toFixed(2)}s of audio`);
    return audio.toBlob();
  };
  const job = queue.then(run);
  queue = job.catch(() => {});
  return job;
}
