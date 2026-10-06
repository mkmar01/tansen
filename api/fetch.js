// GET /api/fetch?url=<page>
// Fetches a web page or PDF server-side so the browser isn't blocked by CORS.
// Protected by the ACCESS_KEY env var so it can't be used as an open proxy.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export async function GET(request) {
  const key = process.env.ACCESS_KEY;
  if (!key) return error(500, 'Server is missing ACCESS_KEY — set it in your hosting environment variables.');
  if (!safeEqual(request.headers.get('x-access-key') || '', key)) {
    return error(401, 'Wrong or missing access key. Add it in Settings.');
  }

  let target;
  try {
    target = new URL(new URL(request.url).searchParams.get('url'));
  } catch {
    return error(400, 'That doesn’t look like a valid link.');
  }

  let upstream;
  try {
    for (let hops = 0; ; hops++) {
      if (!(await isPublicHttpUrl(target))) return error(400, 'That link isn’t allowed.');
      upstream = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const location = upstream.headers.get('location');
      if (upstream.status < 300 || upstream.status >= 400 || !location) break;
      if (hops >= MAX_REDIRECTS) return error(502, 'Too many redirects.');
      target = new URL(location, target);
    }
  } catch (e) {
    return error(502, `Couldn’t reach that site (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }

  if (!upstream.ok) return error(502, `The site responded with ${upstream.status}.`);
  if (Number(upstream.headers.get('content-length')) > MAX_BYTES) return error(413, 'That page is too large.');
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return error(413, 'That page is too large.');

  return new Response(body, {
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'x-final-url': target.href,
      'cache-control': 'no-store',
    },
  });
}

function error(status, message) {
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function isPublicHttpUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
}

export function isPrivateIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
