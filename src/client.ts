import { createHash, createHmac } from 'node:crypto';

export type Params = Record<string, unknown>;
export interface Credentials {
  spotKey?: string; spotSecret?: string;
  futuresKey?: string; futuresSecret?: string;
  futuresDemo?: boolean;
}
export type Transport = typeof fetch;
const queues = new Map<string, Promise<unknown>>();
const nonces = new Map<string, bigint>();

export function nextNonce(key: string): string {
  // Nanoseconds match the official CLI's nonce scale. Monotonic within this worker.
  const now = BigInt(Date.now()) * 1_000_000n;
  const previous = nonces.get(key) ?? 0n;
  const next = now > previous ? now : previous + 1n;
  nonces.set(key, next);
  return String(next);
}
function decodeSecret(secret: string): Buffer {
  if (!secret || !/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length % 4 !== 0) {
    throw new Error('API secret must be valid base64.');
  }
  return Buffer.from(secret, 'base64');
}
export function spotSign(path: string, nonce: string, body: string, secret: string): string {
  const hash = createHash('sha256').update(nonce + body).digest();
  return createHmac('sha512', decodeSecret(secret)).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
}
export function futuresSign(path: string, nonce: string, body: string, secret: string): string {
  const hash = createHash('sha256').update(body + nonce + path).digest();
  return createHmac('sha512', decodeSecret(secret)).update(hash).digest('base64');
}
export function objectParams(value: unknown): Params {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Parameters must be a JSON object.');
  const result = { ...value } as Params;
  for (const k of Object.keys(result)) {
    if (/^(nonce|api[-_]?key|api[-_]?secret|api[-_]?sign|authent)$/i.test(k)) {
      throw new Error('Authentication fields are managed by the connection.');
    }
  }
  return result;
}
export function encodeParams(params: Params): string {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    encoded.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return encoded.toString();
}
export function safeEndpoint(endpoint: string): string {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(endpoint)) {
    throw new Error('Use a Kraken endpoint name or path segments, without a URL, query string or traversal.');
  }
  return endpoint;
}
async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}
export class KrakenClient {
  constructor(private auth: Credentials = {}, private transport: Transport = fetch) {}
  private async response(url: string, init: RequestInit, binary = false): Promise<any> {
    let response: Response;
    try {
      response = await this.transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('Kraken request failed or timed out. No automatic retry was made; check order/transfer status before retrying a write.');
    }
    if (!response.ok) throw new Error(`Kraken HTTP ${response.status}. No automatic retry was made.`);
    const isJson = response.headers.get('content-type')?.includes('json');
    if (binary && !isJson) return { base64: Buffer.from(await response.arrayBuffer()).toString('base64'), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
    let data: any;
    try { data = await response.json(); }
    catch { throw new Error('Kraken returned an invalid JSON response.'); }
    if (Array.isArray(data.error) && data.error.length) throw new Error(`Kraken: ${data.error.join('; ')}`);
    if (data.result === 'error') throw new Error(`Kraken Futures: ${typeof data.error === 'string' ? data.error : 'request rejected'}`);
    return data;
  }
  async spot(endpoint: string, params: Params = {}, authenticated = true, json = false, binary = false): Promise<any> {
    safeEndpoint(endpoint); params = objectParams(params);
    const path = `/0/${authenticated ? 'private' : 'public'}/${endpoint}`;
    if (!authenticated) {
      const query = encodeParams(params);
      const data = await this.response(`https://api.kraken.com${path}${query ? '?' + query : ''}`, { method: 'GET' });
      return data.result;
    }
    const { spotKey: key, spotSecret: secret } = this.auth;
    if (!key || !secret) throw new Error('This action requires a Spot API key and secret in the connection.');
    return serial('spot:' + key, async () => {
      const nonce = nextNonce(key);
      const body = json ? JSON.stringify({ ...params, nonce }) : encodeParams({ nonce, ...params });
      const data = await this.response(`https://api.kraken.com${path}`, {
        method: 'POST', headers: { 'API-Key': key, 'API-Sign': spotSign(path, nonce, body, secret),
          'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body,
      }, binary);
      return binary && data.base64 ? data : data.result;
    });
  }
  async futures(endpoint: string, params: Params = {}, method = 'GET', authenticated = true, prefix = 'api/v3'): Promise<any> {
    safeEndpoint(endpoint); safeEndpoint(prefix); params = objectParams(params);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method.');
    const base = this.auth.futuresDemo ? 'https://demo-futures.kraken.com' : 'https://futures.kraken.com';
    const path = `/${prefix}/${endpoint}`;
    const body = encodeParams(params);
    const request = async () => {
      const headers: Record<string, string> = {};
      if (authenticated) {
        const { futuresKey: key, futuresSecret: secret } = this.auth;
        if (!key || !secret) throw new Error('This action requires separate Futures API credentials.');
        // Futures nonce is optional. Omitting it avoids shared-key ordering issues.
        headers.APIKey = key; headers.Authent = futuresSign(path, '', body, secret);
      }
      const hasBody = method !== 'GET';
      if (hasBody) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      return this.response(`${base}/derivatives${path}${!hasBody && body ? '?' + body : ''}`, {
        method, headers, ...(hasBody ? { body } : {}),
      });
    };
    return authenticated ? serial('futures:' + this.auth.futuresKey, request) : request();
  }
}
