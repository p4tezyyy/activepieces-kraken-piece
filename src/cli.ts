import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Credentials } from './client';

export interface CliCommand {
  name: string; command: string; group: string; description: string;
  auth_required: boolean; dangerous: boolean;
  parameters: { name: string; type: string; required: boolean; positional?: boolean; description?: string; values?: string[] }[];
}
export const advancedCliCommand: CliCommand = { name: '__advanced', command: 'kraken', group: 'advanced',
  description: 'Advanced command', auth_required: false, dangerous: true, parameters: [] };
export function advancedArgs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200 || value.some(v => typeof v !== 'string' || v.length > 100_000 || v.includes('\0'))) {
    throw new Error('Arguments must be a nonempty JSON array of strings (maximum 200 arguments).');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(value[0]) || ['shell', 'setup', 'mcp'].includes(value[0])) throw new Error('Interactive commands and MCP servers cannot run as flow actions.');
  if (value[0] === 'auth' && value[1] !== 'show' && value[1] !== 'test') throw new Error('Manage credentials through Activepieces connections.');
  const blocked = /^--(?:api-(?:key|secret|secret-file|secret-stdin|url)|spot-api-(?:key|secret)|futures-(?:api-key|api-secret|url)|ws-(?:public-url|auth-url|l3-url|url|futures-url)|danger[^=]*|config[^=]*|output|yes|force)(?:=|$)/;
  if (value.some(v => blocked.test(v) || ['-o', '-y', '-f'].includes(v))) throw new Error('Credential, host, TLS, output and confirmation overrides are managed by the piece.');
  return value;
}
export function cliArgs(command: CliCommand, inputs: Record<string, unknown>): string[] {
  const path = command.command.split(' ').slice(1).filter(t => !t.startsWith('<') && !t.startsWith('['));
  const args = [...path];
  for (const p of command.parameters) {
    const key = p.name.replace(/^--/, '').replace(/-/g, '_');
    let value = inputs[key];
    if (value === undefined || value === null || value === '') {
      if (p.required) throw new Error(`Missing CLI parameter: ${p.name}`);
      continue;
    }
    if (p.type === 'boolean') {
      if (value === true) args.push(p.name);
      continue;
    }
    if (command.name === 'order-batch' && key === 'file' && Array.isArray(value)) value = '__inline_orders__';
    const values = Array.isArray(value) ? value : [value];
    if (values.some(v => typeof v !== 'string' && typeof v !== 'number')) throw new Error(`Invalid CLI parameter: ${p.name}`);
    if (values.some(v => String(v).startsWith('-'))) throw new Error(`CLI values cannot start with '-': ${p.name}`);
    if (p.values && values.some(v => !p.values!.includes(String(v)))) throw new Error(`Unsupported value: ${p.name}`);
    if (p.positional || !p.name.startsWith('--')) args.push(...values.map(String));
    else for (const v of values) args.push(p.name, String(v));
  }
  return args;
}
export async function executeCli(command: CliCommand, inputs: Record<string, unknown>, auth: Credentials, options: {
  allowWrites?: boolean; workspace?: string; seconds?: number; maxEvents?: number; otp?: string;
} = {}): Promise<unknown> {
  const args = command.name === '__advanced' ? advancedArgs(inputs.argv) : cliArgs(command, inputs);
  const changesAccount = command.dangerous || (command.command.startsWith('kraken deposit addresses') && inputs.new === true);
  if (changesAccount && !options.allowWrites) throw new Error('Enable Allow Account Changes on this action to run this command.');
  if (process.env.KRAKEN_CLI_BRIDGE_URL) {
    const response = await fetch(process.env.KRAKEN_CLI_BRIDGE_URL + '/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.KRAKEN_CLI_BRIDGE_TOKEN ?? '') },
      body: JSON.stringify({ command: command.name, inputs, auth, options }),
      signal: AbortSignal.timeout(135_000), redirect: 'error',
    });
    const body = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Kraken CLI bridge failed.');
    return body.result;
  }
  const seconds = options.seconds ?? 15;
  const maxEvents = options.maxEvents ?? 10;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new Error('Runtime must be 1–120 seconds.');
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new Error('Maximum events must be 1–1000.');
  if (options.workspace && !/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(options.workspace)) throw new Error('Invalid workspace name.');
  const home = process.env.KRAKEN_PIECE_HOME ?? '/var/lib/kraken-piece';
  await mkdir(home, { recursive: true });
  let temporaryInput: string | undefined;
  if (command.name === 'order-batch' && Array.isArray(inputs.file)) {
    temporaryInput = home + '/batch-' + randomUUID() + '.json';
    await writeFile(temporaryInput, JSON.stringify(inputs.file), { mode: 0o600 });
    args[args.indexOf('__inline_orders__')] = temporaryInput;
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home + '/config',
    XDG_DATA_HOME: home + '/data', XDG_STATE_HOME: home + '/state',
    KRAKEN_API_KEY: auth.spotKey ?? '', KRAKEN_API_SECRET: auth.spotSecret ?? '',
    KRAKEN_FUTURES_API_KEY: auth.futuresKey ?? '', KRAKEN_FUTURES_API_SECRET: auth.futuresSecret ?? '',
    ...(options.otp ? { KRAKEN_OTP: options.otp } : {}),
    ...(auth.futuresDemo ? { KRAKEN_FUTURES_URL: 'https://demo-futures.kraken.com' } : {}),
  };
  args.push('-o', 'json');
  if (options.workspace) args.push('--workspace', options.workspace);
  if (options.allowWrites) args.push('--yes');
  const streaming = ['websocket', 'futures-ws'].includes(command.group) || (command.name === '__advanced' && (args[0] === 'ws' || args[1] === 'ws'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.KRAKEN_CLI_PATH ?? 'kraken', args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false;
    const secrets = [auth.spotKey, auth.spotSecret, auth.futuresKey, auth.futuresSecret, options.otp].filter(Boolean) as string[];
    const redact = (s: string) => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), s);
    const stop = () => { stopped = true; child.kill('SIGTERM'); };
    const timer = setTimeout(stop, seconds * 1000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024 || (streaming && stdout.split('\n').filter(Boolean).length >= maxEvents)) stop();
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.on('error', () => { clearTimeout(timer); if (temporaryInput) void unlink(temporaryInput).catch(() => undefined); reject(new Error('Kraken CLI could not start. Install the provided Docker image or set KRAKEN_CLI_PATH on a self-hosted worker.')); });
    child.on('close', async code => {
      clearTimeout(timer);
      if (temporaryInput) await unlink(temporaryInput).catch(() => undefined);
      if (stopped && !streaming) return reject(new Error('CLI runtime/output limit reached. Check account status before retrying a write.'));
      if (code !== 0 && !stopped) return reject(new Error(`Kraken CLI exited ${code}: ${redact(stderr || stdout).slice(-2000)}`));
      const clean = redact(stdout).trim();
      try { resolve(JSON.parse(clean)); }
      catch {
        const lines = clean.split('\n').filter(Boolean).slice(0, maxEvents);
        resolve({ events: lines.map(line => { try { return JSON.parse(line); } catch { return line; } }), truncated: stopped });
      }
    });
  });
}
