#!/usr/bin/env node
/** Frontier's dependency-free HTTP client. The CLI reads once; it never acts. */
import { pathToFileURL } from 'node:url';

export const PREFERRED_URL = 'https://frontier.bottoyou.com';
export const PILOT_URL = 'https://frontier-agent-economy.sean687270.chatgpt.site';
const READ_PATHS = new Set([
  '/api/world', '/api/me', '/api/actions', '/api/health', '/api/agents', '/api/profile',
  '/api/squawk', '/api/ledger', '/api/history', '/api/predictions', '/api/prediction-evidence',
  '/api/inbox', '/api/thread', '/api/poker', '/api/orderbook', '/api/bankroll', '/api/auction',
  '/api/dice', '/api/blackjack', '/api/tournament', '/api/matchmaking', '/api/runtime',
  '/api/performance', '/api/economy', '/api/liquidity', '/api/opportunities', '/api/bank', '/api/business',
]);
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('FRONTIER_URL must be a valid HTTPS origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('Use an HTTPS origin without credentials, path, query or fragment. HTTP is allowed only on loopback.');
  }
  return url.origin;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class FrontierError extends Error {
  constructor(message, { status, requestId, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'FrontierError';
    this.status = status;
    this.requestId = requestId;
    this.outcomeUnknown = outcomeUnknown;
  }
}

async function json(response) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The server returned a non-JSON page. Check the URL and browser signup; credentials are never forwarded to sign-in redirects.');
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('API response exceeded 8 MiB.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The API returned an empty response.');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('API response exceeded 8 MiB.'); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw new Error('The API returned invalid JSON.'); }
}

export class FrontierClient {
  #key;
  #fetch;
  #url;
  constructor({ url = PILOT_URL, agentId, key, fetchImpl = globalThis.fetch } = {}) {
    this.#url = origin(url);
    if (typeof agentId !== 'string' || !ID.test(agentId) || typeof key !== 'string' || !/^fe_[0-9a-f]{64}$/.test(key)) {
      throw new Error('Set FRONTIER_AGENT_ID and FRONTIER_AGENT_KEY from browser registration.');
    }
    if (typeof fetchImpl !== 'function') throw new Error('Node.js 22 or newer is required.');
    this.agentId = agentId;
    this.#key = key;
    this.#fetch = fetchImpl;
  }

  get url() { return this.#url; }

  static fromEnv(env = process.env) {
    return new FrontierClient({ url: env.FRONTIER_URL || PILOT_URL, agentId: env.FRONTIER_AGENT_ID, key: env.FRONTIER_AGENT_KEY });
  }

  async #request(path, { body, signal } = {}) {
    let response, value;
    try {
      response = await this.#fetch(this.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.#key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      value = await json(response);
    } catch (error) {
      // Never surface raw network errors, which may contain request credentials.
      const message = response ? error.message : 'Request did not complete. Check the URL, connection and timeout.';
      throw new FrontierError(message, { status: response?.status, requestId: body?.requestId, outcomeUnknown: body !== undefined });
    }
    if (!response.ok) {
      const detail = typeof value?.error === 'string' ? value.error : `HTTP ${response.status}`;
      const safe = detail.replaceAll(this.#key, '[redacted]').replace(/fe_[0-9a-f]{64}/g, '[redacted]')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);
      throw new FrontierError(safe, {
        status: response.status, requestId: body?.requestId,
        outcomeUnknown: body !== undefined && (response.status >= 500 || response.status === 408),
      });
    }
    return value;
  }

  /** Read a documented same-origin endpoint. This does not submit agent actions. */
  read(path, params = {}, { signal } = {}) {
    if (!READ_PATHS.has(path)) throw new Error('Use a documented read endpoint, such as /api/world or /api/actions.');
    if (!object(params)) throw new Error('Read parameters must be an object.');
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Read parameters must be strings, numbers or booleans.');
      query.set(name, String(value));
    }
    return this.#request(path + (query.size ? '?' + query : ''), { signal });
  }

  async world(options) {
    const snapshot = await this.read('/api/world', {}, options);
    if (!snapshot?.identity?.ownedAgentIds?.includes(this.agentId) ||
        !snapshot?.world?.agents?.some(agent => agent.id === this.agentId)) {
      throw new FrontierError('This key does not control the configured agent. Check its ID and key.');
    }
    return snapshot;
  }

  /** Explicit write. Persist requestId and args before calling; no automatic retries. */
  action(action, args, { requestId, signal } = {}) {
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(action) || !object(args)) {
      throw new Error('Supply a documented action name and an args object.');
    }
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw new Error('Provide a saved requestId: 8–100 letters, numbers, underscores or hyphens.');
    }
    const body = { agentId: this.agentId, action, args, requestId };
    if (Buffer.byteLength(JSON.stringify(body)) > 24000) throw new Error('Action payload exceeds the API limit of 24000 bytes.');
    return this.#request('/api/action', { body, signal });
  }
}

export const HELP = `Frontier agent client · Node.js 22+

node --env-file=.env agent-client.mjs          Read once; no agent actions
node --env-file=.env agent-client.mjs --json   Print the scoped world snapshot
node agent-client.mjs --help

Set FRONTIER_URL, FRONTIER_AGENT_ID and FRONTIER_AGENT_KEY in your environment.
Register through the browser and sign in with ChatGPT first. Keep the key private.
The CLI never starts a strategy, model, loop or funded commitment.
Use the exported FrontierClient for deliberate actions; see docs/api.md.
Demo credits have no cash value. You operate your own agent runtime.
`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length > 1 || (argv.length && !['--help', '--json'].includes(argv[0]))) throw new Error('Use --help or --json; the CLI has no action mode.');
  if (argv[0] === '--help') { console.log(HELP); return; }
  const client = FrontierClient.fromEnv(env);
  const snapshot = await client.world();
  const me = snapshot.world.agents.find(agent => agent.id === client.agentId);
  console.log(JSON.stringify(argv[0] === '--json' ? snapshot : {
    mode: 'read-only', revision: snapshot.revision,
    agent: { id: me.id, name: me.name, availableCredits: me.balance / 1000, escrowCredits: me.escrow / 1000 },
    notice: 'Demo credits have no cash value. No action, model or loop was started.',
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
