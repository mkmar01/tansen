import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, toChunks } from '../text.js';

test('cleanText strips links, quote markers and markdown', () => {
  const out = cleanText('Hi,\n> quoted line\nSee [the docs](https://x.y/z) or https://a.b/c.\n\n\n\n## Heading\n-----\n**bold**');
  assert.equal(out, 'Hi,\nquoted line\nSee the docs or.\n\nHeading\n\nbold');
});

test('cleanText removes citation markers', () => {
  assert.equal(cleanText('Records.[1] Then tapes.[citation needed] Done[a].'), 'Records. Then tapes. Done.');
});

test('cleanText keeps links when skipLinks is off', () => {
  assert.match(cleanText('go to https://a.b/c now', { skipLinks: false }), /https:\/\/a\.b\/c/);
});

test('toChunks splits paragraphs and sentences', () => {
  const chunks = toChunks('Hello there. How are you?\n\nSecond paragraph!');
  assert.deepEqual(chunks.map(c => [c.text, c.p]), [
    ['Hello there.', 0], ['How are you?', 0], ['Second paragraph!', 1],
  ]);
});

test('toChunks re-joins hard-wrapped email lines but keeps short lines', () => {
  const wrapped = 'This is a long line of an email that was hard wrapped by the mail client at\n'
    + 'seventy two columns so it continues here.';
  const chunks = toChunks(`Hi Sam,\n${wrapped}\nThanks\nAlex`);
  assert.deepEqual(chunks.map(c => c.text), [
    'Hi Sam,',
    'This is a long line of an email that was hard wrapped by the mail client at seventy two columns so it continues here.',
    'Thanks',
    'Alex',
  ]);
});

test('toChunks breaks very long sentences into short pieces', () => {
  const long = Array.from({ length: 60 }, (_, i) => `clause number ${i}`).join(', ') + '.';
  const chunks = toChunks(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.text.length <= 221), 'all chunks short');
  assert.equal(chunks.map(c => c.text).join(' '), long);
});

test('toChunks skips punctuation-only fragments', () => {
  assert.deepEqual(toChunks('—\n\n* * *\n\nReal text.').map(c => c.text), ['Real text.']);
});
