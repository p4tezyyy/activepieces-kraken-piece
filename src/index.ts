import { createPiece, createAction, createTrigger, PieceAuth, Property, TriggerStrategy, InputPropertyMap } from '@activepieces/pieces-framework';
import { KrakenClient, Credentials, objectParams } from './client';
import { executeCli, CliCommand, advancedCliCommand } from './cli';
import { pollHistory, PollState } from './poll';
import endpoints from './endpoints.json';
import catalog from './catalog.json';

const secret = (displayName: string) => PieceAuth.SecretText({ displayName, required: false });
export const krakenAuth = PieceAuth.CustomAuth({
  required: true,
  description: 'Public data needs no connection. Add Spot and/or separate Futures credentials for private actions. Use a dedicated Spot key per worker; serialize flows sharing it. CLI actions require the provided self-hosted Docker image. Futures demo credentials belong to the demo environment.',
  props: {
    spotKey: secret('Spot API Key'), spotSecret: secret('Spot API Secret'),
    futuresKey: secret('Futures API Key'), futuresSecret: secret('Futures API Secret'),
    futuresDemo: Property.Checkbox({ displayName: 'Use Futures Demo Environment', required: false, defaultValue: false }),
  },
  async validate({ auth }) {
    if (!!auth.spotKey !== !!auth.spotSecret || !!auth.futuresKey !== !!auth.futuresSecret) return { valid: false, error: 'Supply both key and secret for each enabled API.' };
    for (const value of [auth.spotSecret, auth.futuresSecret].filter(Boolean)) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value!) || value!.length % 4) return { valid: false, error: 'API secrets must be base64.' };
    }
    // Structural validation allows least-privilege keys without requiring Query Funds.
    return { valid: true };
  },
});
export function credentials(auth: unknown): Credentials {
  if (!auth || typeof auth !== 'object') return {};
  return ('props' in auth ? auth.props : auth) as Credentials;
}
const allowChanges = () => Property.Checkbox({ displayName: 'Allow Account Changes', description: 'Enable deliberately for orders, withdrawals, transfers, allocation changes or other writes. Requests are never automatically retried.', required: true, defaultValue: false });
const paramsProp = () => Property.Json({ displayName: 'Additional API Parameters', description: 'Kraken wire-format parameters. Decimal amounts/prices should be strings. Supports pagination and all optional endpoint fields. Authentication fields are generated.', required: false, defaultValue: {} });
const text = (displayName: string, required = false) => Property.ShortText({ displayName, required });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_$/, '');
function assertChanges(allow: unknown) { if (allow !== true) throw new Error('Enable Allow Account Changes before this operation.'); }

const nativeActions = endpoints.map(def => {
  const props: InputPropertyMap = {};
  for (const field of def.fields) props[field] = text(field);
  props.parameters = paramsProp();
  props.otp = Property.ShortText({ displayName: 'One-Time Password', description: 'Only for Spot keys with API 2FA enabled. Use a fresh code.', required: false });
  if (def.write) props.allowChanges = allowChanges();
  return createAction({
    auth: krakenAuth, requireAuth: def.private,
    name: `${def.family}_${slug(def.name)}`,
    displayName: `${def.family === 'spot' ? 'Spot' : 'Futures'}: ${def.name}`,
    description: `${def.write ? 'Changes account state. ' : ''}${def.family === 'spot' ? '/0/' + (def.private ? 'private/' : 'public/') : '/derivatives/api/v3/'}${def.endpoint}. Returns Kraken data with decimal strings preserved.`,
    props,
    async run(context) {
      if (def.write) assertChanges(context.propsValue.allowChanges);
      const params = objectParams(context.propsValue.parameters);
      for (const field of def.fields) if (context.propsValue[field] != null && context.propsValue[field] !== '') params[field] = context.propsValue[field];
      if (context.propsValue.otp) params.otp = context.propsValue.otp;
      if (def.name === 'Validate Order') params.validate = true;
      if (def.endpoint === 'DepositAddresses') params.new = def.write;
      const client = new KrakenClient(credentials(context.auth));
      if (def.family === 'spot') {
        const result = await client.spot(def.endpoint, params, def.private, def.json, def.binary);
        if (def.binary && result?.base64) {
          const url = await context.files.write({ fileName: 'kraken-export.zip', data: Buffer.from(result.base64, 'base64') });
          return { file: url, contentType: result.contentType };
        }
        return result;
      }
      return client.futures(def.endpoint, params, def.method, def.private);
    },
  });
});

const customSpot = createAction({
  auth: krakenAuth, requireAuth: false, name: 'spot_api_request', displayName: 'Spot: Custom API Request',
  description: 'Call any Spot REST endpoint, including new endpoints. Signed automatically. Private custom calls require explicit write opt-in because the endpoint may change account state.',
  props: {
    endpoint: text('Endpoint (e.g. Balance or Earn/Strategies)', true),
    authenticated: Property.Checkbox({ displayName: 'Authenticated Request', required: true, defaultValue: true }),
    parameters: paramsProp(), jsonBody: Property.Checkbox({ displayName: 'JSON Request Body', required: false, defaultValue: false }),
    allowChanges: allowChanges(),
  },
  async run(ctx) {
    if (ctx.propsValue.authenticated) assertChanges(ctx.propsValue.allowChanges);
    return new KrakenClient(credentials(ctx.auth)).spot(ctx.propsValue.endpoint!, objectParams(ctx.propsValue.parameters), ctx.propsValue.authenticated, ctx.propsValue.jsonBody);
  },
});
const customFutures = createAction({
  auth: krakenAuth, requireAuth: false, name: 'futures_api_request', displayName: 'Futures: Custom API Request',
  description: 'Call Futures v3 endpoints and alternate API prefixes such as api/history/v3. Preserves the complete response and execution status.',
  props: {
    endpoint: text('Endpoint', true), prefix: Property.ShortText({ displayName: 'API Prefix', required: true, defaultValue: 'api/v3' }),
    method: Property.StaticDropdown({ displayName: 'HTTP Method', required: true, defaultValue: 'GET', options: { options: ['GET', 'POST', 'PUT', 'DELETE'].map(value => ({ label: value, value })) } }),
    authenticated: Property.Checkbox({ displayName: 'Authenticated Request', required: true, defaultValue: true }),
    parameters: paramsProp(), allowChanges: allowChanges(),
  },
  async run(ctx) {
    if (ctx.propsValue.authenticated || ctx.propsValue.method !== 'GET') assertChanges(ctx.propsValue.allowChanges);
    return new KrakenClient(credentials(ctx.auth)).futures(ctx.propsValue.endpoint!, objectParams(ctx.propsValue.parameters), ctx.propsValue.method, ctx.propsValue.authenticated, ctx.propsValue.prefix);
  },
});

const excludedCli = new Set(['kraken setup', 'kraken shell', 'kraken auth set', 'kraken auth reset']);
export const cliCommands = (catalog.commands as CliCommand[]).filter(c => !excludedCli.has(c.command));
const cliActions = cliCommands.map(command => {
  const props: InputPropertyMap = {};
  for (const p of command.parameters) {
    const key = p.name.replace(/^--/, '').replace(/-/g, '_');
    const common = { displayName: p.name.replace(/^--/, ''), description: p.description, required: p.required };
    if (p.type.endsWith('[]')) props[key] = Property.Json({ ...common, description: (p.description ?? '') + ' Supply a JSON array.' });
    else if (p.type === 'boolean') props[key] = Property.Checkbox({ ...common, defaultValue: false });
    else if (p.values) props[key] = Property.StaticDropdown({ ...common, options: { options: p.values.map(value => ({ label: String(value), value })) } });
    else props[key] = Property.ShortText(common);
  }
  props.cliWorkspace = text('CLI Workspace', false);
  props.cliSeconds = Property.Number({ displayName: 'Maximum Runtime (seconds)', required: true, defaultValue: 15 });
  props.cliMaxEvents = Property.Number({ displayName: 'Maximum Stream Events', required: true, defaultValue: 10 });
  props.allowChanges = allowChanges();
  return createAction({
    auth: krakenAuth, requireAuth: command.auth_required,
    name: 'cli_' + slug(command.name), displayName: `CLI: ${command.command.replace(/^kraken /, '').replace(/ [<\[].*$/, '')}`,
    description: command.description + ' Requires the self-hosted Kraken CLI Docker image. Streaming commands return a bounded event sample. File arguments refer to paths inside the container.',
    props,
    async run(ctx) {
      return executeCli(command, ctx.propsValue, credentials(ctx.auth), {
        allowWrites: ctx.propsValue.allowChanges === true, workspace: ctx.propsValue.cliWorkspace as string | undefined,
        seconds: Number(ctx.propsValue.cliSeconds), maxEvents: Number(ctx.propsValue.cliMaxEvents),
      });
    },
  });
});

const advancedCliAction = createAction({
  auth: krakenAuth, requireAuth: false, name: 'cli_advanced_command', displayName: 'CLI: Advanced Command',
  description: 'Run additional official CLI subcommands using an argv array, without a shell. For recording/replay, lab and future CLI features. Always requires explicit opt-in. Interactive setup/shell/MCP and credential/host overrides are unavailable.',
  props: {
    argv: Property.Json({ displayName: 'Command Arguments', description: 'Example: ["status"]. Omit the initial kraken executable. Each argument is a separate string.', required: true }),
    workspace: text('Workspace'), seconds: Property.Number({ displayName: 'Maximum Runtime (seconds)', required: true, defaultValue: 15 }),
    maxEvents: Property.Number({ displayName: 'Maximum Stream Events', required: true, defaultValue: 10 }), allowChanges: allowChanges(),
  },
  async run(ctx) {
    return executeCli(advancedCliCommand, ctx.propsValue, credentials(ctx.auth), {
      allowWrites: ctx.propsValue.allowChanges === true, workspace: ctx.propsValue.workspace,
      seconds: ctx.propsValue.seconds, maxEvents: ctx.propsValue.maxEvents,
    });
  },
});

const historyTriggers = [
  { name: 'new_trade', displayName: 'New Spot Trade', endpoint: 'TradesHistory', key: 'trades' },
  { name: 'new_closed_order', displayName: 'Spot Order Closed', endpoint: 'ClosedOrders', key: 'closed' },
  { name: 'new_ledger_entry', displayName: 'New Ledger Entry', endpoint: 'Ledgers', key: 'ledger' },
].map(def => createTrigger({
  auth: krakenAuth, name: def.name, displayName: def.displayName,
  description: 'Polls all pages since the previous check. Starts at enable time; test fetches recent examples. Schedule is every minute. Ledger entries include deposits, withdrawals, transfers and rewards.',
  type: TriggerStrategy.POLLING, props: {}, sampleData: {},
  async onEnable(ctx) {
    await ctx.store.put('cursor', { start: Math.floor(Date.now() / 1000), seen: [] });
    ctx.setSchedule({ cronExpression: '* * * * *', timezone: 'UTC' });
  },
  async onDisable(ctx) { await ctx.store.delete('cursor'); },
  async test(ctx) {
    const result = await new KrakenClient(credentials(ctx.auth)).spot(def.endpoint);
    return Object.entries(result[def.key] ?? {}).slice(0, 5).map(([id, row]) => ({ id, ...row as object }));
  },
  async run(ctx) {
    const now = Math.floor(Date.now() / 1000);
    const state = await ctx.store.get<PollState>('cursor') ?? { start: now, seen: [] };
    const client = new KrakenClient(credentials(ctx.auth));
    const result = await pollHistory(state, now, async (ofs, start, end) => {
      const data = await client.spot(def.endpoint, { ofs, start, end });
      return { rows: data[def.key], count: data.count };
    });
    await ctx.store.put('cursor', result.state);
    return result.events;
  },
}));

export const kraken = createPiece({
  displayName: 'Kraken', description: 'Kraken Spot and Futures: market data, trading, balances, funding, Earn, subaccounts, exports, polling triggers and the official CLI including paper trading and bounded WebSocket streams.',
  logoUrl: 'https://assets.kraken.com/marketing/web/icons/favicon.png',
  authors: [], auth: krakenAuth, minimumSupportedRelease: '0.82.0',
  actions: [...nativeActions, customSpot, customFutures, ...cliActions, advancedCliAction], triggers: historyTriggers,
});
