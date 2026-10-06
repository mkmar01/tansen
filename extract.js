// Turns web pages, PDFs, Word docs and text files into plain text.
// Parsing libraries load from a CDN only when first needed (then the service worker caches them).

const LIBS = {
  readability: 'https://esm.sh/@mozilla/readability@0.5.0',
  pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
};

const BLOCKS = 'p,div,section,article,header,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr,dt,dd,figcaption,table,ul,ol,hr';

export async function fromFile(file) {
  const title = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') {
    return { title, text: await pdfToText(await file.arrayBuffer()) };
  }
  if (ext === 'docx') return { title, text: await docxToText(await file.arrayBuffer()) };
  if (ext === 'html' || ext === 'htm' || file.type === 'text/html') {
    return htmlToArticle(await file.text(), null, title);
  }
  return { title, text: await file.text() };
}

export async function fromUrl(url, accessKey) {
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, {
    headers: { 'x-access-key': accessKey || '' },
  });
  if (!res.ok) {
    const msg = await res.json().then(j => j.error, () => null);
    throw new Error(msg || `Couldn't fetch that page (${res.status}).`);
  }
  const type = res.headers.get('content-type') || '';
  const finalUrl = res.headers.get('x-final-url') || url;
  const { hostname, pathname } = new URL(finalUrl);
  if (type.includes('pdf')) {
    const name = decodeURIComponent(pathname.split('/').pop() || '').replace(/\.pdf$/i, '');
    return { title: name || hostname, text: await pdfToText(await res.arrayBuffer()) };
  }
  const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim() || 'utf-8';
  const body = decode(await res.arrayBuffer(), charset);
  if (type.includes('html') || type.includes('xml')) return htmlToArticle(body, finalUrl, hostname);
  return { title: hostname, text: body };
}

function decode(buf, charset) {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

async function htmlToArticle(html, baseUrl, fallbackTitle) {
  const { Readability } = await import(LIBS.readability);
  const parse = () => new DOMParser().parseFromString(html, 'text/html'); // inert: scripts never run
  const doc = parse();
  if (baseUrl) {
    const base = doc.createElement('base');
    base.href = baseUrl;
    doc.head.prepend(base);
  }
  const article = new Readability(doc).parse();
  const root = article
    ? new DOMParser().parseFromString(`<!doctype html><html><body>${article.content}</body></html>`, 'text/html').body
    : parse().body; // Readability mutates its input, so re-parse for the fallback
  const title = (article?.title || doc.title || fallbackTitle).trim();
  const body = htmlToText(root).trim();
  const intro = [title, article?.byline].filter(s => s && !body.startsWith(s));
  return { title, text: [...intro, body].join('\n\n') };
}

export function htmlToText(root) {
  root.querySelectorAll('script,style,noscript,template,svg,iframe,button,nav,footer,form').forEach(el => el.remove());
  // Collapse source-code whitespace so only real block boundaries become line breaks.
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('pre')) n.data = n.data.replace(/\s+/g, ' ');
  }
  root.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
  root.querySelectorAll(BLOCKS).forEach(el => {
    el.before('\n\n');
    el.after('\n\n');
  });
  return root.textContent;
}

async function pdfToText(buf) {
  const pdfjs = await import(LIBS.pdfjs);
  pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let out = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    const { items } = await (await pdf.getPage(n)).getTextContent();
    let lastY = null;
    for (const item of items) {
      if (!item.str) continue;
      const y = item.transform[5];
      const lineHeight = item.height || 10;
      if (lastY !== null && Math.abs(y - lastY) > lineHeight * 0.5) {
        out += Math.abs(y - lastY) > lineHeight * 1.8 ? '\n\n' : ' '; // big gap = new paragraph
      }
      out += item.str;
      lastY = y;
    }
    out += '\n\n';
  }
  if (!out.trim()) throw new Error('This PDF has no text layer (it may be a scanned image).');
  return out.replace(/(\p{L})- (\p{Ll})/gu, '$1$2'); // re-join hyphenated line breaks
}

async function docxToText(buf) {
  if (!window.mammoth) await loadScript(LIBS.mammoth);
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return value;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });
}
