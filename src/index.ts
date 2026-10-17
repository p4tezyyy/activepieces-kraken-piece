import { createPiece, createAction, createTrigger, PieceAuth, Property, TriggerStrategy, InputPropertyMap } from '@activepieces/pieces-framework';
import { KrakenClient, Credentials, objectParams } from './client';
import { executeCli, CliCommand, advancedCliCommand } from './cli';
import { pollHistory, PollState } from './poll';
import endpoints from './endpoints.json';
import catalog from './catalog.json';
import krakenLogo from './assets/kraken.png';
import { actionFields, fieldProperty, fieldLabel, nativeParams, inputSchemas, FieldSchema, normalizeField } from './forms';

const secret = (displayName: string) => PieceAuth.SecretText({ displayName, required: false });
export const krakenAuth = PieceAuth.CustomAuth({
  required: true,
  description: 'Public data needs no connection. Add Spot and/or separate Futures credentials for private actions. Use a dedicated Spot key per worker; serialize flows sharing it. CLI actions require the provided self-hosted Docker image. Futures demo credentials belong to the demo environment.',
  props: {
    spotKey: secret('Spot API Key'), spotSecret: secret('Spot API Secret'),
    futuresKey: secret('Futures API Key'), futuresSecret: secret('Futures API Secret'),
    futuresDemo: Property.Checkbox({ displayName: 'Use Futures Demo Environment', required: false, defaultValue: false }),
    spotApi2fa: Property.Checkbox({ displayName: 'My Spot API key requires a 2FA code', description: 'Leave off unless you explicitly enabled API-key 2FA in Kraken. This is separate from your Kraken website login.', required: false, defaultValue: false }),
    defaultWorkspace: Property.ShortText({ displayName: 'Default paper trading account (optional)', description: 'A named CLI workspace for paper trading actions, such as my-strategy. Leave empty to use the CLI default. This does not select a Kraken subaccount.', required: false }),
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
  const fields = actionFields(def);
  const primary = fields.filter(field => field.schema.required || def.fields.includes(field.key) || fields.length <= 6);
  primary.sort((a, b) => {
    const rank = (key: string) => { const i = def.fields.indexOf(key); return i < 0 ? 100 : i; };
    return rank(a.key) - rank(b.key);
  });
  const secondary = fields.filter(field => !primary.includes(field));
  const family = def.endpoint.startsWith('Withdraw') ? 'withdrawal' : def.family;
  for (const field of primary) props[field.key] = fieldProperty(field.key.split('__').at(-1)!, field.schema, family, krakenAuth);
  if (secondary.length) props.showAdvanced = Property.Checkbox({ displayName: 'Show optional settings', description: 'Add filters, pagination, order flags and other optional fields.', required: false, defaultValue: false });
  if (secondary.length || (def.private && def.family === 'spot')) {
    props.advancedInputs = Property.DynamicProperties({ auth: krakenAuth, displayName: 'Optional settings', required: false, refreshers: ['showAdvanced', 'auth', 'asset'],
      props: async (values) => {
        const extra: InputPropertyMap = {};
        if (values.showAdvanced) for (const field of secondary) extra[field.key] = fieldProperty(field.key.split('__').at(-1)!, field.schema, family, krakenAuth);
        if (def.private && def.family === 'spot' && credentials(values.auth).spotApi2fa) {
          extra.otp = Property.ShortText({ displayName: 'Current API 2FA code', description: 'A fresh one-time code for this API key. Map it from your preceding step. Required only because this connection has API-key 2FA enabled.', required: true });
        }
        return extra;
      },
    });
  }
  if (def.write) props.allowChanges = allowChanges();
  return createAction({
    auth: krakenAuth, requireAuth: def.private,
    name: `${def.family}_${slug(def.name)}`,
    displayName: `${def.family === 'spot' ? 'Spot' : 'Futures'}: ${def.name}`,
    description: `${inputSchemas[def.family + ':' + def.name].description}. Fill in the fields or map values from earlier steps.${def.write ? ' This action changes your Kraken account.' : ''}`,
    props,
    async run(context) {
      if (def.write) assertChanges(context.propsValue.allowChanges);
      const params = nativeParams(def, context.propsValue);
      if (def.endpoint === 'AddOrder') {
        if (params.ordertype !== 'market' && params.ordertype !== 'settle-position' && !params.price) throw new Error('Price is required for the selected order type. Enter it or map a price from an earlier step.');
        if (['stop-loss-limit', 'take-profit-limit', 'trailing-stop-limit'].includes(String(params.ordertype)) && !params.price2) throw new Error('Secondary price is required for this order type.');
      }
      if (def.family === 'spot' && def.private && credentials(context.auth).spotApi2fa && !params.otp) throw new Error('This connection requires a current API 2FA code. Map it under Optional settings.');
      if (def.name === 'Validate Order') params.validate = true;
      if (def.endpoint === 'DepositAddresses') params.new = def.write;
      const client = new KrakenClient(credentials(context.auth));
      if (def.family === 'spot') {
        const structuredBody = def.json || (def.private && Object.values(params).some(value => value !== null && typeof value === 'object'));
        const result = await client.spot(def.endpoint, params, def.private, structuredBody, def.binary);
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
  const streaming = ['websocket', 'futures-ws'].includes(command.group);
  const paper = ['paper', 'futures-paper'].includes(command.group);
  const routing = paper || ['trade', 'account'].includes(command.group);
  const inputSchemasForCli: Record<string, FieldSchema> = {};
  for (const p of command.parameters) {
    const key = p.name.replace(/^--/, '').replace(/-/g, '_');
    let schema: FieldSchema = { type: p.type.endsWith('[]') ? 'array' : p.type === 'integer' ? 'integer' : p.type === 'boolean' ? 'boolean' : 'string', required: p.required, description: p.description,
      ...(p.values ? { enum: p.values } : {}), ...(p.type.endsWith('[]') ? { items: { type: 'string' } } : {}) };
    if (command.name === 'order-batch' && key === 'file') {
      schema = inputSchemas['spot:Place Batch Orders'].fields.orders;
    } else if (['futures-batch-order', 'futures-paper-batch-order'].includes(command.name) && key.toLowerCase() === 'json') {
      schema = inputSchemas['futures:Batch Orders'].fields.json.properties!.batchOrder;
    }
    inputSchemasForCli[key] = schema;
    props[key] = fieldProperty(key === 'file' && command.name === 'order-batch' ? 'orders' : key.toLowerCase() === 'json' ? 'batchOrder' : key, schema, command.group === 'futures' ? 'futures' : 'spot', krakenAuth);
  }
  if (paper) props.paperAccount = Property.ShortText({ displayName: 'Paper trading account (optional)', description: 'Map the name returned by Create workspace, or enter an existing paper account name. Leave empty to use the default set in your connection.', required: false });
  if (streaming) {
    props.cliSeconds = Property.Number({ displayName: 'Listen for up to (seconds)', required: true, defaultValue: 15 });
    props.cliMaxEvents = Property.Number({ displayName: 'Stop after this many events', required: true, defaultValue: 10 });
  }
  props.showAdvanced = Property.Checkbox({ displayName: 'Show optional settings', required: false, defaultValue: false });
  props.advancedInputs = Property.DynamicProperties({ auth: krakenAuth, displayName: 'Optional settings', required: false, refreshers: ['showAdvanced', 'auth'],
    props: async values => {
      const extra: InputPropertyMap = {};
      if (values.showAdvanced) {
        if (!streaming) extra.cliSeconds = Property.Number({ displayName: 'Request timeout (seconds)', required: false, defaultValue: 15 });
        if (routing && !paper) extra.cliWorkspace = Property.ShortText({ displayName: 'Run in a named paper account (optional)', description: 'Only set this to deliberately route the operation to an existing CLI workspace. Leave empty for your Kraken account.', required: false });
      }
      if (command.auth_required && command.group !== 'futures' && command.group !== 'futures-ws' && credentials(values.auth).spotApi2fa) extra.otp = Property.ShortText({ displayName: 'Current API 2FA code', description: 'Map a fresh code for this Spot API key.', required: true });
      return extra;
    },
  });
  if (command.dangerous || command.command.startsWith('kraken deposit addresses')) props.allowChanges = allowChanges();
  return createAction({
    auth: krakenAuth, requireAuth: command.auth_required,
    name: 'cli_' + slug(command.name), displayName: `CLI: ${command.command.replace(/^kraken /, '').replace(/ [<\[].*$/, '')}`,
    description: command.description + (streaming ? ' Returns events up to the selected count or time limit.' : ''),
    props,
    async run(ctx) {
      const inputs = { ...ctx.propsValue };
      const extra = inputs.advancedInputs as Record<string, unknown> | undefined;
      for (const [key, schema] of Object.entries(inputSchemasForCli)) {
        // Old flows may still supply JSON strings or paths for these two CLI inputs.
        if ((key === 'file' || key.toLowerCase() === 'json') && typeof inputs[key] === 'string') continue;
        const value = normalizeField(inputs[key], schema, fieldLabel(key));
        if (schema.required && value === undefined) throw new Error(`${fieldLabel(key)} is required. Enter it or map a value from an earlier step.`);
        inputs[key] = value;
      }
      if (['futures-batch-order', 'futures-paper-batch-order'].includes(command.name)) {
        const key = command.name === 'futures-paper-batch-order' ? 'JSON' : 'json';
        if (Array.isArray(inputs[key])) inputs[key] = JSON.stringify({ batchOrder: inputs[key] });
      }
      const creds = credentials(ctx.auth);
      const otp = (extra?.otp ?? inputs.otp) as string | undefined;
      if (command.auth_required && !['futures', 'futures-ws'].includes(command.group) && creds.spotApi2fa && !otp) throw new Error('This connection requires a current API 2FA code. Map it under Optional settings.');
      return executeCli(command, inputs, creds, {
        allowWrites: inputs.allowChanges === true, workspace: (inputs.paperAccount || inputs.cliWorkspace || extra?.cliWorkspace || (paper ? creds.defaultWorkspace : undefined)) as string | undefined,
        seconds: Number(inputs.cliSeconds ?? extra?.cliSeconds ?? 15), maxEvents: Number(inputs.cliMaxEvents ?? 10), otp,
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
  logoUrl: krakenLogo,
  authors: [], auth: krakenAuth, minimumSupportedRelease: '0.82.0',
  actions: [...nativeActions, customSpot, customFutures, ...cliActions, advancedCliAction], triggers: historyTriggers,
});
