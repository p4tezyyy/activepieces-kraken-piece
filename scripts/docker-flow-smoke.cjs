const fs = require('node:fs');
const assert = require('node:assert/strict');
const session = JSON.parse(fs.readFileSync('work/ap-session.json'));
const pkg = JSON.parse(fs.readFileSync('package.json'));
const base = process.env.AP_TEST_URL ?? 'http://localhost:8088';
async function api(path, data) {
  const response = await fetch(base + '/api/v1/' + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 2000)}`);
  return JSON.parse(text);
}
(async () => {
  let flow = await api('flows', { displayName: 'Kraken Public Data Smoke Test', projectId: session.projectId });
  const cases = [
    { action: 'spot_ticker', input: { pair: 'XBTUSD', parameters: {} }, label: 'Spot ticker' },
    { action: 'futures_instruments', input: { parameters: {} }, label: 'Futures instruments' },
    { action: 'cli_ticker', input: { pair: ['BTCUSD'], cliSeconds: 15, cliMaxEvents: 2, allowChanges: false }, label: 'Official CLI ticker' },
  ];
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i]; const name = 'step_' + (i + 1);
    flow = await api('flows/' + flow.id, { type: 'ADD_ACTION', request: {
      parentStep: i === 0 ? 'trigger' : 'step_' + i, stepLocationRelativeToParent: 'AFTER',
      action: { name, displayName: item.label, type: 'PIECE', valid: true,
        settings: { pieceName: pkg.name, pieceVersion: pkg.version, actionName: item.action,
          input: item.input, propertySettings: {}, errorHandlingOptions: { retryOnFailure: { value: false }, continueOnFailure: { value: false } } } },
    } });
    const run = await api('sample-data/test-step', { projectId: session.projectId, flowVersionId: flow.version.id, stepName: name });
    console.log(item.label + ':', run.status, 'run', run.id);
    fs.writeFileSync(`work/docker-run-${i}.json`, JSON.stringify(run, null, 2));
    let completed = run;
    for (let attempt = 0; attempt < 40 && !['SUCCEEDED', 'FAILED', 'INTERNAL_ERROR', 'TIMEOUT'].includes(completed.status); attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      completed = await api('flow-runs/' + run.id);
    }
    fs.writeFileSync(`work/docker-run-${i}.json`, JSON.stringify(completed, null, 2));
    assert.equal(completed.status, 'SUCCEEDED', JSON.stringify(completed).slice(-1800));
    console.log('PASS:', item.label, 'through Activepieces engine.');
    results.push({ action: item.action, runId: run.id, status: completed.status });
  }
  fs.writeFileSync('work/docker-smoke-results.json', JSON.stringify({ flowId: flow.id, projectId: session.projectId, results }, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
