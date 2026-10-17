const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { executeCli, advancedCliCommand } = require('./cli.js');
const catalog = require('./catalog.json');
const excluded = new Set(['kraken setup', 'kraken shell', 'kraken auth set', 'kraken auth reset']);
const commands = new Map(catalog.commands.filter(c => !excluded.has(c.command)).map(c => [c.name, c]));
commands.set(advancedCliCommand.name, advancedCliCommand);
const token = process.env.KRAKEN_CLI_BRIDGE_TOKEN;
if (!token || token.length < 32) throw new Error('Set KRAKEN_CLI_BRIDGE_TOKEN to a random secret of at least 32 characters.');
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health' && req.method === 'GET') return res.end('{"ok":true}');
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.statusCode = 401; return res.end('{"error":"Unauthorized"}');
  }
  if (req.url !== '/execute' || req.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Request too large.');
    }
    const input = JSON.parse(body);
    const command = commands.get(input.command);
    if (!command) throw new Error('Unknown or interactive command.');
    const result = await executeCli(command, input.inputs ?? {}, input.auth ?? {}, input.options ?? {});
    res.end(JSON.stringify({ result }));
  } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
});
server.listen(8787, '0.0.0.0', () => console.log('Kraken CLI bridge listening on internal port 8787'));
