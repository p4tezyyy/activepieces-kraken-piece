const { existsSync, writeFileSync, readFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
let content = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
for (const [name, size] of [['KRAKEN_CLI_BRIDGE_TOKEN', 32], ['AP_JWT_SECRET', 32], ['AP_ENCRYPTION_KEY', 16]]) {
  if (!content.includes(name + '=')) content += name + '=' + randomBytes(size).toString('hex') + '\n';
}
writeFileSync('.env', content, { mode: 0o600 });
console.log('Local Docker secrets ready; existing values preserved.');
