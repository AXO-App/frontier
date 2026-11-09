import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FrontierClient, FrontierError, PILOT_URL } from '../agent-client.mjs';

const run = promisify(execFile);
const key = 'fe_' + 'a'.repeat(64); // Deliberately synthetic; never a production credential.
const agentId = 'fixture-agent';
const snapshot = {
  world: { agents: [{ id: agentId, name: 'Local fixture', balance: 100000, escrow: 0 }] },
  identity: { ownedAgentIds: [agentId] }, unit: 1000, revision: 7,
};
const reply = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

async function fixture(t, handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
const client = url => new FrontierClient({ url, agentId, key });

test('default CLI reads once and submits no action, with correct credit conversion', async t => {
  const calls = [];
  const url = await fixture(t, (req, res) => {
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    reply(res, snapshot);
  });
  const { stdout, stderr } = await run(process.execPath, [fileURLToPath(new URL('../agent-client.mjs', import.meta.url))], {
    env: { FRONTIER_URL: url, FRONTIER_AGENT_ID: agentId, FRONTIER_AGENT_KEY: key },
  });
  assert.equal(stderr, '');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'GET', path: '/api/world', authorization: `Bearer ${key}` });
  const output = JSON.parse(stdout);
  assert.equal(output.mode, 'read-only');
  assert.equal(output.agent.availableCredits, 100);
  assert.equal(output.agent.escrowCredits, 0);
  assert.ok(!stdout.includes(key));
});

test('world verifies ownership instead of accepting another agent ID', async t => {
  const url = await fixture(t, (_req, res) => reply(res, { ...snapshot, identity: { ownedAgentIds: ['someone-else'] } }));
  await assert.rejects(client(url).world(), /does not control/);
});

test('redirect is not followed and credentials never reach the target route', async t => {
  let targetCalls = 0;
  const url = await fixture(t, (req, res) => {
    if (req.url === '/target') { targetCalls++; reply(res, snapshot); return; }
    res.writeHead(302, { Location: '/target' }); res.end();
  });
  await assert.rejects(client(url).world(), error => error instanceof FrontierError && !error.outcomeUnknown);
  assert.equal(targetCalls, 0);
});

test('explicit action preserves exact agent, args and request ID with no retry', async t => {
  const received = [];
  const url = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
    reply(res, { result: { ok: true } });
  });
  const value = await client(url).action('profile_update', { availability: 'available' }, { requestId: 'fixture-request-1' });
  assert.deepEqual(value, { result: { ok: true } });
  assert.deepEqual(received, [{ method: 'POST', path: '/api/action', type: 'application/json', body: {
    agentId, action: 'profile_update', args: { availability: 'available' }, requestId: 'fixture-request-1',
  } }]);
});

test('JSON write failures at 503 and 408 preserve uncertain outcome and request ID', async t => {
  for (const status of [503, 408]) {
    let calls = 0;
    const url = await fixture(t, (_req, res) => { calls++; reply(res, { error: 'Response failed after a possible commit.' }, status); });
    await assert.rejects(client(url).action('profile_update', {}, { requestId: 'saved-request-503' }), error =>
      error instanceof FrontierError && error.status === status && error.requestId === 'saved-request-503' && error.outcomeUnknown);
    assert.equal(calls, 1);
  }
});

test('network loss during a write is uncertain and does not retry or expose credentials', async t => {
  let calls = 0;
  const url = await fixture(t, (req) => { calls++; req.socket.destroy(); });
  await assert.rejects(client(url).action('profile_update', {}, { requestId: 'saved-request-network' }), error =>
    error.outcomeUnknown && error.requestId === 'saved-request-network' && !error.message.includes(key));
  assert.equal(calls, 1);
});

test('API errors redact reflected keys and access errors are not retried', async t => {
  let calls = 0;
  const url = await fixture(t, (_req, res) => { calls++; reply(res, { error: `Rejected ${key}\nfor this actor` }, 403); });
  await assert.rejects(client(url).action('profile_update', {}, { requestId: 'saved-request-denied' }), error =>
    error.status === 403 && !error.outcomeUnknown && !error.message.includes(key) && error.message.includes('[redacted]'));
  assert.equal(calls, 1);
});

test('reads encode parameters and reject arbitrary endpoints before any request', async t => {
  const paths = [];
  const url = await fixture(t, (req, res) => { paths.push(req.url); reply(res, { agents: [] }); });
  const api = client(url);
  await api.read('/api/agents', { q: 'two words & symbols', limit: 20 });
  assert.equal(new URL(paths[0], url).searchParams.get('q'), 'two words & symbols');
  assert.throws(() => api.read('https://elsewhere.test/api/world'), /documented read/);
  assert.throws(() => api.read('/api/action'), /documented read/);
  assert.equal(paths.length, 1);
});

test('official prediction research is available through the scoped read client', async t => {
  const received = [];
  const research = { marketId: 'public-market', observations: [{ value: 12 }] };
  const url = await fixture(t, (req, res) => {
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    reply(res, { research });
  });
  assert.deepEqual(await client(url).read('/api/prediction-research', { marketId: research.marketId }), { research });
  assert.deepEqual(received, [{ method: 'GET', path: '/api/prediction-research?marketId=public-market', authorization: `Bearer ${key}` }]);
});

test('configuration rejects unsafe origins and malformed credentials without network', () => {
  for (const url of ['http://remote.test', 'https://user:password@host.test', 'https://host.test/path', 'https://host.test?key=x', 'https://host.test#x']) {
    assert.throws(() => client(url), /origin/);
  }
  assert.throws(() => new FrontierClient({ url: 'https://host.test', agentId, key: 'not-a-key' }), /AGENT_KEY/);
  const api = client('https://host.test');
  assert.throws(() => { api.url = 'https://elsewhere.test'; }, TypeError);
  assert.equal(api.url, 'https://host.test');
  assert.equal(new FrontierClient({ agentId, key }).url, PILOT_URL);
  assert.ok(!JSON.stringify(api).includes(key));
});

test('actions require a durable request ID and enforce API payload size before network', () => {
  const api = client('https://host.test');
  assert.throws(() => api.action('profile_update', {}), /saved requestId/);
  assert.throws(() => api.action('profile_update', {}, { requestId: 'short' }), /saved requestId/);
  assert.throws(() => api.action('profile_update', { bio: 'x'.repeat(24000) }, { requestId: 'oversize-request' }), /24000/);
});

test('HTML and oversized responses are rejected rather than used as world data', async t => {
  const html = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Sign in</html>'); });
  await assert.rejects(client(html).world(), /non-JSON/);
  const large = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 9 * 1024 * 1024 });
    res.end('{}');
  });
  await assert.rejects(client(large).world(), /8 MiB/);
});
