# Tansen

A personal web app (PWA) that reads emails, documents and web pages aloud like an audiobook.
Install it on your iPhone's home screen; it works offline and keeps your library on the device.

- **Paste** any text (emails, notes). Pasting a link imports that page.
- **Web pages & PDF links**: the article text is extracted, so menus, ads and comments are skipped.
- **Files**: PDF, Word (.docx), HTML, Markdown, plain text.
- Highlights the sentence being read and follows along. Tap any sentence to jump there.
- Remembers your place in every item. Has speed control, a sleep timer, a choice of voices and lock-screen media controls.
- Uses free voices, so there are no API keys or costs: the device's built-in voices (Web Speech API), or
  **High quality** AI voices (Kokoro-82M) that run on-device, on the GPU through WebGPU when available.
  Pick them in Settings → Voice. They download once (about 300 MB with WebGPU, 90 MB on CPU).

## Deploy (free, ~5 minutes)

1. Push this folder to a GitHub repo (private is fine).
2. On [vercel.com](https://vercel.com), choose **Add New → Project**, import the repo, and use the default settings (no build step).
3. Under **Settings → Environment Variables**, add `ACCESS_KEY` set to a long random string
   (e.g. `openssl rand -hex 24`). Redeploy.
   This key protects the page-fetching endpoint so strangers can't use it as a proxy.

Or from a terminal: `npx vercel`, then `npx vercel env add ACCESS_KEY`, then `npx vercel --prod`.

## Set up on iPhone

1. Open your `https://<project>.vercel.app` URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open the app, tap **Settings**, paste your `ACCESS_KEY`, and pick a voice.
4. For much better voices, go to iPhone **Settings → Accessibility → Spoken Content → Voices → English**,
   and download an **Enhanced** or **Premium** voice (e.g. "Ava (Premium)"). Reopen the app and select it.

### Reading an email
In Mail, long-press the message body, then tap **Select All → Copy**. In Tansen, tap **+ → Paste from clipboard → Add & listen**.

## Known limitation: screen lock
iOS stops browser speech when the screen locks or you switch apps. Tansen keeps the screen awake while
playing (toggle this in Settings) and picks up the current sentence when you return. Reading with the screen
locked needs pre-generated audio files, for example from Amazon Polly, which would be a future upgrade.

## Handing content to the app
`https://<app>/?url=<encoded link>` or `?text=<encoded text>&title=<title>` adds the item and starts the player.
Use this from bookmarklets or a browser extension.

> On iOS, the home-screen app and Safari have **separate storage**, so links opened from other apps land in
> Safari's copy. The planned inbox below fixes this.

## Roadmap: Gmail extension
1. Add `api/inbox.js` backed by a free KV store (Upstash Redis / Vercel KV). `POST` adds `{title, text}` and `GET` drains the queue,
   both protected by `ACCESS_KEY`.
2. A Chrome extension adds a **Listen** button to Gmail's toolbar that reads the open message (`div.a3s`) and POSTs it to the inbox.
3. Tansen checks the inbox on launch and imports any new items, so they show up on your phone.

## Develop
- `npx vercel dev` runs the app and API locally. `python3 -m http.server` works for everything except web-page import.
- `npm test` runs the unit tests (Node 20+).

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI, library, player |
| `text.js` | Text cleanup and splitting into sentences |
| `extract.js` | Web page, PDF and DOCX extraction (libraries load from a CDN on first use) |
| `store.js` | IndexedDB library and reading positions |
| `sw.js`, `manifest.webmanifest` | Offline support and install metadata |
| `api/fetch.js` | Serverless page fetcher (bypasses CORS), with access-key protection and private-IP blocking |

## License
[MIT](LICENSE). The app loads third-party libraries and models at runtime from CDNs and Hugging Face
(Kokoro-82M and kokoro-js, Apache-2.0; Readability, Apache-2.0; pdf.js, Apache-2.0; mammoth, BSD-2-Clause).
They are not bundled in this repository and keep their own licenses.
