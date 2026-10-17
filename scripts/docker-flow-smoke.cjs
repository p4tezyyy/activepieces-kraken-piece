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
  flow = await api('flows/' + flow.id, { type: 'ADD_ACTION', request: {
    parentStep: 'trigger', stepLocationRelativeToParent: 'AFTER',
    action: { name: 'inputs', displayName: 'Set Kraken input values', type: 'CODE', valid: true,
      settings: { sourceCode: { packageJson: '{"dependencies":{}}', code: 'export const code = async (inputs) => inputs;' },
        input: { pair: 'XBTUSD', cliPairs: ['BTCUSD'] }, errorHandlingOptions: { retryOnFailure: { value: false } } } },
  } });
  const inputRun = await api('sample-data/test-step', { projectId: session.projectId, flowVersionId: flow.version.id, stepName: 'inputs' });
  for (let attempt = 0; attempt < 40; attempt++) {
    const finished = await api('flow-runs/' + inputRun.id);
    if (finished.status === 'SUCCEEDED') {
      assert.equal(finished.steps.inputs.output.pair, 'XBTUSD');
      await api('flows/' + flow.id, { type: 'SAVE_SAMPLE_DATA', request: { stepName: 'inputs', payload: finished.steps.inputs.output, type: 'OUTPUT' } });
      flow = await api('flows/' + flow.id);
      break;
    }
    if (['FAILED', 'INTERNAL_ERROR', 'TIMEOUT'].includes(finished.status)) throw new Error('Input step failed: ' + JSON.stringify(finished.steps));
    if (attempt === 39) throw new Error('Input step timed out.');
    await new Promise(r => setTimeout(r, 1000));
  }
  const cases = [
    { action: 'spot_ticker', input: { pair: '{{inputs.pair}}' }, label: 'Spot ticker from mapped input' },
    { action: 'futures_instruments', input: { parameters: {} }, label: 'Futures instruments' },
    { action: 'cli_ticker', input: { pair: '{{inputs.cliPairs}}' }, label: 'CLI ticker from mapped list' },
  ];
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i]; const name = 'step_' + (i + 1);
    flow = await api('flows/' + flow.id, { type: 'ADD_ACTION', request: {
      parentStep: i === 0 ? 'inputs' : 'step_' + i, stepLocationRelativeToParent: 'AFTER',
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
    if (item.action === 'spot_ticker') assert.equal(completed.steps[name].input.pair, 'XBTUSD');
    if (item.action === 'cli_ticker') assert.deepEqual(completed.steps[name].input.pair, ['BTCUSD']);
    await api('flows/' + flow.id, { type: 'SAVE_SAMPLE_DATA', request: { stepName: name, payload: completed.steps[name].output, type: 'OUTPUT' } });
    flow = await api('flows/' + flow.id);
    console.log('PASS:', item.label, 'through Activepieces engine.');
    results.push({ action: item.action, runId: run.id, status: completed.status });
  }
  fs.writeFileSync('work/docker-smoke-results.json', JSON.stringify({ flowId: flow.id, projectId: session.projectId, results }, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
