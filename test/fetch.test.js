import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, isPrivateIp } from '../api/fetch.js';

const call = (url, key = 'secret') =>
  GET(new Request(`http://app.test/api/fetch?url=${encodeURIComponent(url)}`, { headers: { 'x-access-key': key } }));

test('rejects requests without the right access key', async () => {
  process.env.ACCESS_KEY = 'secret';
  assert.equal((await call('https://example.com', 'nope')).status, 401);
  assert.equal((await call('https://example.com', '')).status, 401);
});

test('check mode verifies the access key without fetching anything', async () => {
  process.env.ACCESS_KEY = 'secret';
  const check = key => GET(new Request('http://app.test/api/fetch?check=1', { headers: { 'x-access-key': key } }));
  assert.equal((await check('secret')).status, 200);
  assert.equal((await check('nope')).status, 401);
});

test('fails closed when ACCESS_KEY is not configured', async () => {
  delete process.env.ACCESS_KEY;
  assert.equal((await call('https://example.com')).status, 500);
});

test('blocks private, local and non-http targets', async () => {
  process.env.ACCESS_KEY = 'secret';
  for (const url of ['http://localhost:3000', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/', 'file:///etc/passwd', 'http://10.0.0.5/', 'not a url']) {
    const res = await call(url);
    assert.equal(res.status, 400, url);
  }
});

test('isPrivateIp', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
    assert.ok(!isPrivateIp(ip), ip);
  }
});

test('fetches a real public page (skipped when offline)', async t => {
  process.env.ACCESS_KEY = 'secret';
  const res = await call('https://example.com/');
  if (res.status === 502) return t.skip('no outbound network');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /html/);
  assert.match(await res.text(), /Example Domain/);
});
