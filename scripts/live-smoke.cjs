const assert = require('node:assert/strict');
const { KrakenClient } = require('../work/test-lib/client.js');
(async () => {
  const client = new KrakenClient();
  const time = await client.spot('Time', {}, false);
  assert.equal(typeof time.unixtime, 'number');
  const ticker = await client.spot('Ticker', { pair: 'XBTUSD' }, false);
  assert.ok(Object.values(ticker)[0].c[0]);
  const futures = await client.futures('instruments', {}, 'GET', false);
  assert.equal(futures.result, 'success');
  assert.ok(Array.isArray(futures.instruments));
  console.log('PASS: live Spot time, Spot ticker and Futures instruments (public only).');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
