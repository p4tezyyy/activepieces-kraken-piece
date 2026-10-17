import { Property, InputPropertyMap, InputProperty, PieceAuthProperty } from '@activepieces/pieces-framework';
import { Credentials, KrakenClient, objectParams, Params } from './client';
import rawSchemas from './input-schemas.json';

export interface FieldSchema {
  type: string; required?: boolean; description?: string; enum?: unknown[];
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
  properties?: Record<string, FieldSchema>; items?: FieldSchema;
}
export interface EndpointDefinition { family: string; name: string; endpoint: string; private: boolean; fields: string[] }
export const inputSchemas = rawSchemas.actions as Record<string, { description: string; fields: Record<string, FieldSchema> }>;
const OMIT = '__kraken_default__';
const labels: Record<string, string> = {
  pair: 'Trading pair', symbol: 'Futures contract', asset: 'Asset', amount: 'Amount',
  type: 'Type', ordertype: 'Order type', orderType: 'Order type', volume: 'Quantity', size: 'Contract quantity',
  price: 'Price', price2: 'Secondary price', limitPrice: 'Limit price', stopPrice: 'Trigger price',
  cl_ord_id: 'Client order ID', cliOrdId: 'Client order ID', userref: 'Order reference',
  txid: 'Kraken order ID', order_id: 'Order ID', orderId: 'Order ID', id: 'ID',
  strategy_id: 'Earn strategy', ofs: 'Skip records', start: 'From timestamp', end: 'To timestamp',
  count: 'Maximum results', interval: 'Candle interval (minutes)', since: 'Since cursor or timestamp',
  trades: 'Include related trades', docalcs: 'Include position calculations',
  method: 'Funding method', key: 'Saved withdrawal address', timeout: 'Timeout (seconds)',
  asset_class: 'Asset class', assetVersion: 'Asset identifier format', account_id: 'Wallet account ID',
  rebase_multiplier: 'xStocks balance format', oflags: 'Order flags', timeinforce: 'Time in force',
  reduce_only: 'Reduce existing position only', stptype: 'Self-trade prevention',
  displayvol: 'Visible iceberg quantity', leverage: 'Leverage', maxLeverage: 'Maximum leverage',
  order_qty: 'New quantity', limit_price: 'New limit price', trigger_price: 'New trigger price',
  'close[ordertype]': 'Closing order type', 'close[price]': 'Closing price', 'close[price2]': 'Closing secondary price',
  orders: 'Orders', cl_ord_ids: 'Client order IDs', batchOrder: 'Batch instructions', order: 'Instruction',
  report: 'Report type', format: 'File format', fields: 'Report columns',
  starttm: 'Start time', endtm: 'End time', expiretm: 'Expiry time',
  refid: 'Transfer reference', from: 'Source account', to: 'Destination account',
  username: 'Subaccount username', email: 'Subaccount email',
};
export function fieldLabel(name: string): string {
  return labels[name] ?? name.replace(/^--/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());
}
function optionLabel(value: unknown): string {
  const names: Record<string, string> = { buy: 'Buy', sell: 'Sell', market: 'Market', limit: 'Limit', mkt: 'Market', lmt: 'Limit', post: 'Post only', stp: 'Stop', ioc: 'Immediate or cancel', fok: 'Fill or kill', send: 'Place order', edit: 'Edit order', cancel: 'Cancel order', currency: 'Cryptocurrency / fiat', tokenized_asset: 'xStocks', forex: 'Forex' };
  return names[String(value)] ?? fieldLabel(String(value));
}
function help(schema: FieldSchema, name: string): string | undefined {
  if (['volume', 'amount', 'price', 'price2', 'order_qty', 'limit_price', 'trigger_price'].includes(name)) return 'Enter a decimal amount or map a value from an earlier step. Decimal precision is preserved.';
  if (name === 'pair') return 'Choose a pair or switch to a dynamic value from an earlier step.';
  if (name === 'json') return 'Configure each instruction using the fields below.';
  const description = schema.description?.split(/(?<=[.!?])\s/)[0];
  return description && description.length <= 180 ? description : undefined;
}
const cache = new Map<string, { expires: number; result: any }>();
async function cached(key: string, fetcher: () => Promise<any>) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.result;
  const result = await fetcher(); cache.set(key, { expires: Date.now() + 300_000, result }); return result;
}
function authValue(auth: unknown): Credentials { return auth && typeof auth === 'object' ? ('props' in auth ? auth.props : auth) as Credentials : {}; }
export function choiceProperty(name: string, schema: FieldSchema, family: string, auth: PieceAuthProperty | undefined): InputProperty | undefined {
  if (!['pair', 'asset', 'symbol', 'strategy_id', 'method', 'key'].includes(name) || schema.type !== 'string') return;
  const dependent = ['method', 'key'].includes(name);
  return Property.Dropdown({ auth, displayName: fieldLabel(name), description: help(schema, name), required: !!schema.required,
    refreshers: dependent ? ['auth', 'asset'] : ['auth'], refreshOnSearch: true,
    options: async (inputs, context) => {
      const creds = authValue(inputs.auth); const client = new KrakenClient(creds);
      try {
        let options: { label: string; value: string }[] = [];
        if (name === 'pair') {
          const data = await cached('spot:pairs', () => client.spot('AssetPairs', {}, false));
          options = Object.entries(data).map(([id, row]: [string, any]) => ({ label: row.wsname ?? row.altname ?? id, value: row.altname ?? id }));
        } else if (name === 'asset') {
          const data = await cached('spot:assets', () => client.spot('Assets', {}, false));
          options = Object.entries(data).map(([id, row]: [string, any]) => ({ label: row.altname ?? id, value: id }));
        } else if (name === 'symbol') {
          const data = await cached('futures:instruments:' + !!creds.futuresDemo, () => client.futures('instruments', {}, 'GET', false));
          options = data.instruments.map((row: any) => ({ label: row.symbol, value: row.symbol }));
        } else {
          if (!creds.spotKey) return { disabled: true, placeholder: 'Choose a Kraken connection first', options: [] };
          if (dependent && !inputs.asset) return { disabled: true, placeholder: 'Choose an asset first', options: [] };
          const endpoint = name === 'strategy_id' ? 'Earn/Strategies' : name === 'key' ? 'WithdrawAddresses' : family === 'withdrawal' ? 'WithdrawMethods' : 'DepositMethods';
          const data = await client.spot(endpoint, inputs.asset ? { asset: inputs.asset } : {});
          const rows = Array.isArray(data) ? data : data.items ?? data.strategies ?? [];
          options = rows.map((row: any) => ({ label: row.name ?? row.method ?? row.key ?? row.id, value: row.id ?? row.method ?? row.key }));
        }
        const query = context.searchValue?.toLowerCase() ?? '';
        return { options: options.filter(o => o.value && (o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query))).slice(0, 200) };
      } catch { return { disabled: false, placeholder: 'Could not load choices. Map a dynamic value or try again.', options: [] }; }
    },
  });
}
export function fieldProperty(name: string, schema: FieldSchema, family: string, auth?: PieceAuthProperty, inRow = false): InputProperty {
  const common = { displayName: name === 'type' && schema.enum?.includes('buy') ? 'Side' : fieldLabel(name), description: help(schema, name), required: !!schema.required };
  // Dropdowns inside repeatable rows are static; arbitrary dynamic row values remain supported.
  if (!inRow) { const choice = choiceProperty(name, schema, family, auth); if (choice) return choice; }
  if ((schema.enum && schema.type !== 'array') || schema.type === 'boolean') {
    const values = schema.enum ?? [true, false];
    return Property.StaticDropdown({ ...common, ...(schema.required ? {} : { defaultValue: OMIT }), options: { options: [
      ...(schema.required ? [] : [{ label: 'Use Kraken default', value: OMIT }]),
      ...values.map(value => ({ label: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : optionLabel(value), value })),
    ] } });
  }
  if (schema.type === 'array') {
    if (schema.items?.enum) return Property.StaticMultiSelectDropdown({ ...common, ...(!schema.required ? { defaultValue: [] } : {}), options: { options: schema.items.enum.map(value => ({ label: optionLabel(value), value })) } });
    if (!schema.items?.properties) return Property.Array({ ...common, ...(!schema.required ? { defaultValue: [] } : {}) });
    const properties: InputPropertyMap = {};
    if (schema.items?.properties) {
      for (const [key, value] of Object.entries(schema.items.properties)) properties[key] = fieldProperty(key, value, family, auth, true);
    }
    return Property.Array({ ...common, ...(!schema.required ? { defaultValue: [] } : {}), properties: properties as any });
  }
  if (schema.type === 'integer') return Property.Number(common);
  // Prices and quantities are text, even where the Futures schema says number.
  if (schema.type === 'number') return Property.ShortText({ ...common, description: 'Decimal value. Map a value from an earlier step or enter it directly.' });
  if (schema.type === 'object') return Property.Object(common);
  return Property.ShortText(common);
}
export interface FormField { key: string; path: string[]; schema: FieldSchema }
export function actionFields(def: EndpointDefinition): FormField[] {
  const fields: FormField[] = [];
  for (const [key, schema] of Object.entries(inputSchemas[def.family + ':' + def.name].fields)) {
    if (schema.type === 'object' && schema.properties) {
      for (const [child, value] of Object.entries(schema.properties)) fields.push({ key: key + '__' + child, path: [key, child], schema: value });
    } else fields.push({ key, path: [key], schema });
  }
  return fields;
}
function hasValue(value: unknown) { return value !== undefined && value !== null && value !== '' && value !== OMIT; }
export function normalizeField(value: any, schema: FieldSchema, label: string): any {
  if (!hasValue(value)) return undefined;
  if (schema.type === 'array') {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new Error(`${label}: map an array or add rows with Add item.`); } }
    if (!Array.isArray(value)) throw new Error(`${label}: expected a list.`);
    if (!value.length && !schema.required) return undefined;
    if (!value.length && schema.required) throw new Error(`${label}: add at least one item or map a nonempty list.`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${label}: add at least ${schema.minItems} items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label}: use at most ${schema.maxItems} items.`);
    return value.map((row, i) => {
      if (!schema.items?.properties) return normalizeField(typeof row === 'object' && row !== null && 'value' in row ? row.value : row, schema.items ?? { type: 'string' }, label);
      const result: Params = {};
      for (const [key, field] of Object.entries(schema.items.properties)) {
        const normalized = normalizeField(row?.[key], field, fieldLabel(key));
        if (field.required && normalized === undefined) throw new Error(`${label}, item ${i + 1}: ${fieldLabel(key)} is required.`);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    });
  }
  if (schema.enum && !schema.enum.some(v => String(v) === String(value))) throw new Error(`${label}: choose a supported value.`);
  if (schema.type === 'boolean') return value === true || value === 'true';
  if (schema.type === 'integer' || schema.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number) || (schema.type === 'integer' && !Number.isInteger(number))) throw new Error(`${label}: enter a valid ${schema.type === 'integer' ? 'whole number' : 'number'}.`);
    if (schema.minimum !== undefined && number < schema.minimum) throw new Error(`${label}: minimum is ${schema.minimum}.`);
    if (schema.maximum !== undefined && number > schema.maximum) throw new Error(`${label}: maximum is ${schema.maximum}.`);
    return schema.type === 'integer' ? number : String(value);
  }
  return value;
}
export function nativeParams(def: EndpointDefinition, inputs: Record<string, unknown>): Params {
  // Hidden compatibility for 0.1.x flows. New forms expose every supported field.
  const params = objectParams(inputs.parameters);
  if (typeof params.json === 'string') { try { params.json = JSON.parse(params.json); } catch { throw new Error('Batch instructions: the mapped JSON is invalid.'); } }
  const advanced = typeof inputs.advancedInputs === 'object' && inputs.advancedInputs ? inputs.advancedInputs as Params : {};
  for (const field of actionFields(def)) {
    const raw = inputs[field.key] ?? advanced[field.key] ?? (field.path.length === 1 ? params[field.key] : (params[field.path[0]] as Params | undefined)?.[field.path[1]]);
    const value = normalizeField(raw, field.schema, fieldLabel(field.path.at(-1)!));
    if (field.schema.required && value === undefined) throw new Error(`${fieldLabel(field.path.at(-1)!)} is required. Enter it or map a value from an earlier step.`);
    if (field.path.length === 1) {
      if (value !== undefined) params[field.key] = value; else delete params[field.key];
    } else if (value !== undefined) {
      params[field.path[0]] = { ...params[field.path[0]] as Params, [field.path[1]]: value };
    }
  }
  if (inputs.otp || advanced.otp) params.otp = inputs.otp ?? advanced.otp;
  return params;
}
