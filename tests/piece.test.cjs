const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { KrakenClient, spotSign, futuresSign, nextNonce, safeEndpoint, objectParams } = require('../work/test-lib/client.js');
const { cliArgs, executeCli, advancedArgs } = require('../work/test-lib/cli.js');
const { pollHistory } = require('../work/test-lib/poll.js');
const { kraken, cliCommands, credentials } = require('../dist/src/index.js');
const key = 'unit-test-public-key';
const secret = Buffer.alloc(64, 42).toString('base64');
const connection = { spotKey: key, spotSecret: secret, futuresKey: key, futuresSecret: secret };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('Spot signing matches Kraken official published vector', () => {
  const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
  const body = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
  assert.equal(spotSign('/0/private/AddOrder', '1616492376594', body, secret), '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
});
test('Futures signs the encoded wire body and path', () => {
  const body = 'greeting=hello+world&json=%7B%22a%22%3A1%7D';
  const hash = createHash('sha256').update(body + '/api/v3/batchorder').digest();
  const expected = createHmac('sha512', Buffer.from(secret, 'base64')).update(hash).digest('base64');
  assert.equal(futuresSign('/api/v3/batchorder', '', body, secret), expected);
});
test('Nonces remain monotonic in the same millisecond', () => {
  const values = Array.from({ length: 100 }, () => BigInt(nextNonce(key)));
  assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]));
});
test('Endpoint and credential injection are rejected', () => {
  for (const value of ['https://evil.test', '../Balance', 'Balance?new=true', 'Balance#x', '/Balance']) assert.throws(() => safeEndpoint(value));
  for (const field of ['nonce', 'api_key', 'API-Sign', 'Authent']) assert.throws(() => objectParams({ [field]: 'bad' }));
  assert.throws(() => objectParams([]));
});
test('Private Spot request signs the exact form body and preserves decimals', async () => {
  const client = new KrakenClient(connection, async (url, init) => {
    assert.equal(url, 'https://api.kraken.com/0/private/Balance');
    assert.equal(init.method, 'POST');
    const nonce = new URLSearchParams(init.body).get('nonce');
    assert.equal(init.headers['API-Sign'], spotSign('/0/private/Balance', nonce, init.body, secret));
    assert.equal(init.redirect, 'error');
    return json({ error: [], result: { XXBT: '0.0000000100' } });
  });
  assert.deepEqual(await client.spot('Balance'), { XXBT: '0.0000000100' });
});
test('Batch Spot JSON requests preserve nested arrays and sign JSON bytes', async () => {
  const orders = [{ ordertype: 'limit', type: 'buy', volume: '0.01', price: '100' }];
  const client = new KrakenClient(connection, async (_, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.orders, orders);
    assert.equal(init.headers['API-Sign'], spotSign('/0/private/AddOrderBatch', body.nonce, init.body, secret));
    return json({ error: [], result: { orders: [] } });
  });
  await client.spot('AddOrderBatch', { orders }, true, true);
});
test('Futures demo/private GET keeps query parameters in signature', async () => {
  const client = new KrakenClient({ ...connection, futuresDemo: true }, async (url, init) => {
    assert.equal(url, 'https://demo-futures.kraken.com/derivatives/api/v3/fills?lastFillTime=a+b');
    assert.equal(init.headers.Authent, futuresSign('/api/v3/fills', '', 'lastFillTime=a+b', secret));
    assert.equal(init.body, undefined);
    return json({ result: 'success', fills: [] });
  });
  await client.futures('fills', { lastFillTime: 'a b' });
});
test('API errors propagate and writes are not retried', async () => {
  let count = 0;
  const client = new KrakenClient(connection, async () => { count++; return json({ error: ['EOrder:Insufficient funds'] }); });
  await assert.rejects(client.spot('AddOrder'), /Insufficient funds/);
  assert.equal(count, 1);
  const failed = new KrakenClient(connection, async () => { throw new Error('network failure'); });
  await assert.rejects(failed.spot('AddOrder'), /No automatic retry/);
});
test('HTTP and malformed JSON failures surface clearly', async () => {
  const limited = new KrakenClient({}, async () => new Response('', { status: 429 }));
  await assert.rejects(limited.spot('Time', {}, false), /HTTP 429/);
  const invalid = new KrakenClient({}, async () => new Response('<html>'));
  await assert.rejects(invalid.spot('Time', {}, false), /invalid JSON/);
});
test('Export download supports binary and recognizes JSON Kraken errors', async () => {
  const client = new KrakenClient(connection, async () => new Response(Buffer.from([80, 75, 3, 4]), { headers: { 'content-type': 'application/zip' } }));
  assert.equal((await client.spot('RetrieveExport', { id: 'test' }, true, false, true)).base64, 'UEsDBA==');
  const error = new KrakenClient(connection, async () => json({ error: ['EGeneral:Invalid arguments'] }));
  await assert.rejects(error.spot('RetrieveExport', {}, true, false, true), /Invalid arguments/);
});
test('Same-key private requests are serialized', async () => {
  let concurrent = 0, max = 0;
  const client = new KrakenClient(connection, async () => {
    concurrent++; max = Math.max(max, concurrent);
    await new Promise(r => setTimeout(r, 5)); concurrent--;
    return json({ error: [], result: {} });
  });
  await Promise.all([client.spot('Balance'), client.spot('OpenOrders'), client.spot('TradeBalance')]);
  assert.equal(max, 1);
});
test('Bundle exports all actions with unique names and valid metadata', () => {
  assert.equal(Object.keys(kraken.actions()).length, 263);
  assert.equal(Object.keys(kraken.triggers()).length, 3);
  const names = [...Object.values(kraken.actions())].map(a => a.name);
  assert.equal(new Set(names).size, 263);
  assert.equal(kraken.constructor.name, 'Piece');
  assert.equal(kraken.metadata().displayName, 'Kraken');
  assert.equal(cliCommands.length, 170);
});
test('Credentials support current and older Activepieces context layouts', () => {
  assert.deepEqual(credentials({ props: connection }), connection);
  assert.deepEqual(credentials(connection), connection);
  assert.deepEqual(credentials(undefined), {});
});
test('Write actions fail before fetching without explicit opt-in', async () => {
  for (const name of ['spot_place_order', 'spot_withdraw_funds', 'spot_earn_allocate', 'futures_place_order']) {
    await assert.rejects(kraken.getAction(name).run({ propsValue: { parameters: {}, allowChanges: false } }), /Allow Account Changes/);
  }
});
test('Validate order and deposit address reads cannot be turned into writes', async () => {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (_, init) => { requests.push(new URLSearchParams(init.body)); return json({ error: [], result: {} }); };
  try {
    await kraken.getAction('spot_validate_order').run({ auth: { props: connection }, propsValue: { parameters: { validate: false } } });
    await kraken.getAction('spot_deposit_addresses').run({ auth: { props: connection }, propsValue: { parameters: { new: true } } });
    assert.equal(requests[0].get('validate'), 'true');
    assert.equal(requests[1].get('new'), 'false');
  } finally { global.fetch = original; }
});
test('Custom private API requests require opt-in', async () => {
  await assert.rejects(kraken.getAction('spot_api_request').run({ propsValue: { authenticated: true, endpoint: 'Withdraw' } }), /Allow Account Changes/);
  await assert.rejects(kraken.getAction('futures_api_request').run({ propsValue: { authenticated: true, method: 'GET', endpoint: 'accounts' } }), /Allow Account Changes/);
});
test('CLI positional arrays and flags become argv without a shell', () => {
  const command = cliCommands.find(c => c.command.startsWith('kraken ticker '));
  assert.deepEqual(cliArgs(command, { pair: ['BTCUSD', 'ETHUSD'] }), ['ticker', 'BTCUSD', 'ETHUSD']);
  assert.throws(() => cliArgs(command, { pair: ['--api-url=evil'] }), /cannot start/);
  const input = ['BTCUSD; touch /tmp/evil'];
  assert.deepEqual(cliArgs(command, { pair: input }), ['ticker', input[0]]);
});
test('Dangerous CLI commands are gated before spawning', async () => {
  const command = cliCommands.find(c => c.command.startsWith('kraken withdraw '));
  await assert.rejects(executeCli(command, { asset: 'BTC', key: 'test', amount: '1' }, {}), /Allow Account Changes/);
});
test('CLI address creation requires write opt-in even though address listing is read-only', async () => {
  const command = cliCommands.find(c => c.command.startsWith('kraken deposit addresses'));
  await assert.rejects(executeCli(command, { asset: 'BTC', method: 'Bitcoin', new: true }, {}), /Allow Account Changes/);
});
test('Advanced CLI blocks interactive commands and credential/host overrides', () => {
  assert.deepEqual(advancedArgs(['schema']), ['schema']);
  for (const args of [['shell'], ['auth', 'set'], ['ticker', '--api-url=https://bad.test'], ['ticker', '--danger-accept-invalid-certs'], ['ticker', '-o', 'table']]) assert.throws(() => advancedArgs(args));
});
test('Polling consumes multiple pages, sorts, and deduplicates overlap', async () => {
  const calls = [];
  const result = await pollHistory({ start: 90, seen: ['a'] }, 100, async (ofs, start, end) => {
    calls.push([ofs, start, end]);
    return ofs === 0 ? { rows: { b: { time: 99 }, a: { time: 98 } }, count: 3 } : { rows: { c: { time: 97 } }, count: 3 };
  });
  assert.deepEqual(calls, [[0, 90, 100], [2, 90, 100]]);
  assert.deepEqual(result.events.map(e => e.id), ['c', 'b']);
  assert.equal(result.state.start, 98);
  assert.ok(result.events.every(e => e._dedupe_key === e.id));
});
test('Polling refuses incomplete pages without returning a new cursor', async () => {
  await assert.rejects(pollHistory({ start: 1, seen: [] }, 100, async () => ({ rows: {}, count: 50 })), /pagination stopped/);
});
