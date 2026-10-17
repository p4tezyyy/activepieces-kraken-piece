const fs = require('node:fs');
const crypto = require('node:crypto');
const base = process.env.AP_TEST_URL ?? 'http://localhost:8088';
async function request(path, options = {}) {
  const response = await fetch(base + '/api/v1/' + path, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 1500)}`);
  return JSON.parse(text);
}
(async () => {
  fs.mkdirSync('work', { recursive: true });
  const credentialFile = 'work/local-admin.json';
  if (!fs.existsSync(credentialFile)) fs.writeFileSync(credentialFile, JSON.stringify({ email: 'admin@kraken-piece.local', password: crypto.randomBytes(24).toString('base64url') }, null, 2));
  const credentials = JSON.parse(fs.readFileSync(credentialFile));
  let session;
  try {
    session = await request('authentication/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  } catch {
    session = await request('authentication/sign-up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...credentials, firstName: 'Kraken', lastName: 'Local Test', trackEvents: false, newsLetter: false }) });
  }
  fs.writeFileSync('work/ap-session.json', JSON.stringify(session));
  const pkg = JSON.parse(fs.readFileSync('package.json'));
  const form = new FormData();
  for (const [key, value] of Object.entries({ packageType: 'ARCHIVE', scope: 'PLATFORM', pieceName: pkg.name, pieceVersion: pkg.version })) form.set(key, value);
  form.set('pieceArchive', new Blob([fs.readFileSync(`dist/${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`)], { type: 'application/gzip' }), 'piece.tgz');
  const result = await request('pieces', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token }, body: form });
  fs.writeFileSync('work/installed-piece.json', JSON.stringify(result, null, 2));
  console.log(`Installed ${result.name}@${result.version}: ${Object.keys(result.actions).length} actions, ${Object.keys(result.triggers).length} triggers.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
