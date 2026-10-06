// Text cleanup and splitting into short, speakable chunks.

const MAX_CHUNK = 220; // long utterances get cut off or stall on some browsers
const CHARS_PER_SECOND = 15; // ~160 words per minute at 1x
const WRAPPED_LINE_MIN = 60; // plain-text emails hard-wrap around 72 columns

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
  : null;

export function cleanText(text, { skipLinks = true } = {}) {
  let t = String(text).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  // Markdown: [label](url) -> label, drop heading/emphasis markers.
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\[(?:\d+|[a-z]|citation needed|edit)\]/gi, ''); // footnote/citation markers
  if (skipLinks) t = t.replace(/<?(?:https?:\/\/|www\.)[^\s>]*[^\s>.,;:!?)]>?/g, ' ');
  return t
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '') // email quote markers
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/^[-_=*~#· ]{3,}$/gm, '') // decorative divider lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Returns [{ text, p, l }] where p is the paragraph index and l the line within it.
export function toChunks(text) {
  const chunks = [];
  let p = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const lines = mergeWrappedLines(block.split('\n').map(s => s.trim()).filter(Boolean));
    if (!lines.length) continue;
    lines.forEach((line, l) => {
      for (const s of sentences(line)) chunks.push({ text: s, p, l });
    });
    p++;
  }
  return chunks;
}

export function estimateSeconds(chars, rate = 1) {
  return chars / CHARS_PER_SECOND / rate;
}

// Joins hard-wrapped lines back together while keeping short lines
// (greetings, list items, signatures) as their own lines.
function mergeWrappedLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.length >= WRAPPED_LINE_MIN && !/[.!?:;]["'”’)\]]*$/.test(prev)) {
      out[out.length - 1] = `${prev} ${line}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

function sentences(line) {
  const parts = segmenter
    ? Array.from(segmenter.segment(line), s => s.segment)
    : line.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g) || [line];
  return parts
    .map(s => s.trim())
    .filter(s => /[\p{L}\p{N}]/u.test(s))
    .flatMap(splitLong);
}

function splitLong(s) {
  const out = [];
  let rest = s;
  while (rest.length > MAX_CHUNK) {
    let cut = Math.max(rest.lastIndexOf(', ', MAX_CHUNK), rest.lastIndexOf('; ', MAX_CHUNK), rest.lastIndexOf(' — ', MAX_CHUNK));
    if (cut < MAX_CHUNK * 0.4) cut = rest.lastIndexOf(' ', MAX_CHUNK);
    if (cut <= 0) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}
