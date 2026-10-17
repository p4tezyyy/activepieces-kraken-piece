const fs = require('node:fs');
const session = JSON.parse(fs.readFileSync('work/ap-session.json'));
const pkg = JSON.parse(fs.readFileSync('package.json'));
const piece = require('../dist/src/index.js').kraken;
const id = process.argv[2];
if (!id) throw new Error('Pass the ID of the local flow to upgrade.');
async function api(path, data) {
  const response = await fetch('http://localhost:8088/api/v1/' + path, {
    method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) throw new Error(response.status + ': ' + (await response.text()).slice(0, 500));
  return response.json();
}
(async () => {
  const flow = await api('flows/' + id);
  fs.writeFileSync(`work/flow-${id}-before-upgrade.json`, JSON.stringify(flow, null, 2));
  const steps = [];
  function collect(node) { if (!node) return; if (node.type === 'PIECE' && node.settings.pieceName === pkg.name) steps.push(node); collect(node.nextAction); for (const child of node.children ?? []) collect(child); }
  collect(flow.version.trigger);
  for (const step of steps) {
    const action = piece.getAction(step.settings.actionName);
    if (!action) continue;
    const input = { ...step.settings.input };
    const advanced = { ...(input.advancedInputs ?? {}) };
    const extra = action.props.advancedInputs ? await action.props.advancedInputs.props({ showAdvanced: true }, {}) : {};
    for (const [key, value] of Object.entries(input.parameters ?? {})) {
      if (key in action.props && input[key] == null) input[key] = value;
      else if (key in extra && advanced[key] == null) advanced[key] = value;
    }
    for (const key of Object.keys(extra)) if (input[key] != null && !(key in action.props)) { advanced[key] = input[key]; delete input[key]; }
    if (Object.keys(advanced).length) { input.advancedInputs = advanced; input.showAdvanced = true; }
    const settings = { ...step.settings, pieceVersion: pkg.version, input };
    delete settings.sampleData;
    await api('flows/' + id, { type: 'UPDATE_ACTION', request: { name: step.name, displayName: step.displayName, type: 'PIECE', valid: step.valid, ...(step.skip !== undefined ? { skip: step.skip } : {}), settings } });
  }
  console.log(`Updated ${steps.length} Kraken steps in ${flow.version.displayName} to ${pkg.version}. Existing input values preserved.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
