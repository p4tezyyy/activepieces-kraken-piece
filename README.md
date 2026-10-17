# Kraken for Activepieces

Independent integration for Kraken Spot and Futures, funding, Earn, subaccounts,
reports, and the official Kraken CLI. Node.js 22+; Activepieces 0.82.0+.

## Coverage

- 90 native REST actions with optional endpoint fields exposed as JSON.
- Custom signed Spot and Futures REST actions for additional API endpoints.
- CLI action forms generated from Kraken CLI 0.4.1's official catalogue, including
  paper trading, futures paper trading, workspace/session/lab tools, and bounded
  WebSocket event samples. CLI actions need the supplied self-hosted image.
- Three polling triggers: new Spot trade, closed order, and ledger entry. Ledger
  entries cover deposits, withdrawals, transfers, fees, and rewards.
- Interactive `setup`, `shell`, and persistent credential `auth set/reset`
  commands are intentionally excluded from flow actions. Configure credentials
  through Activepieces connections. This is not a continuously running WebSocket
  subscription service: stream actions return samples within a runtime limit.

Native actions return Kraken's original decimal strings and field names. CLI
actions return the CLI's normalized schema. Futures responses retain operation
status: `result: success` alone does not mean an order was placed or filled.
Pagination remains under the caller's control for actions. Polling triggers
fetch all pages within their window and fail without advancing on incomplete pages.

## Connections

Public market actions work without credentials. A connection can contain Spot
credentials, separate Futures credentials, or both. Secrets stay in the
connection. Futures demo is selectable in the connection. Connection validation
checks key-pair completeness and base64 formatting without accessing balances.
Use the API Key Info / Balance or Futures Accounts action to verify permissions.
Spot API 2FA codes can be passed to native actions as an action property (treat run input logs as sensitive).

Use a dedicated Spot key for this integration. Nonces are serialized and
monotonic inside one worker process; multiple worker processes or simultaneous
native/CLI calls sharing a Spot key can still race. Serialize those flows, use
separate keys, or configure Kraken's nonce window. CLI paper/workspace state is
persistent in the Docker volume and shared by flows on that worker; select
distinct workspace names where isolation is needed. This local image is intended
for a single trusted user, not a multi-tenant worker.

Writes require the action's **Allow Account Changes** checkbox. Validate Order
always sets `validate=true`. Reading deposit addresses always sets `new=false`;
creating an address is a separate write action. Requests are never automatically
retried, since a timed-out order/transfer can already have been accepted.
Use an approval step in your flows when human review is needed.

## Develop and test

```powershell
npm ci
npm test
npm run test:live
npm run docker:setup
docker compose up -d --build
```

Activepieces runs at http://localhost:8088 and binds only to loopback. Its embedded
database and CLI state use separate Docker volumes. The first user registered
in this local test instance becomes its administrator.

`npm test` uses mocked Kraken responses and signing vectors; `test:live` calls
only unauthenticated market endpoints. No private account requests, orders,
withdrawals or transfers are performed by the tests.

## Package and publish

```powershell
npm run pack:piece
npm publish --access public
```

The root npm package contains a self-contained CommonJS bundle; no framework
dependencies are installed at runtime. `dist/package` is a second manifest layout
for Activepieces upload, with `main: ./src/index.js`.

```powershell
npm pack ./dist/package --pack-destination ./dist
```

For installations that support custom pieces: Platform Admin Ã¢â€ â€™ Catalogue Ã¢â€ â€™ Pieces
Ã¢â€ â€™ Install Piece Ã¢â€ â€™ Upload File, then select the generated `.tgz`. npm publication
does not automatically add the piece to Activepieces' public catalogue; community
listing requires the Activepieces contribution/review process. The supplied
Docker setup is also used to test local API installation and execution.

After Docker starts, run `npm pack ./dist/package --pack-destination ./dist`,
`npm run docker:install`, and `npm run docker:test`. The local administrator
credentials are generated in `work/local-admin.json`; this file is git-ignored
and excluded from npm. Open the test flow in the local instance to inspect results.
The CLI runs in a separate Debian container over a token-authenticated bridge on
the private Compose network. Only Activepieces port 8088 is exposed to the host.
`npm run docker:test:cli` verifies the advanced command, an isolated paper
workspace, and a bounded WebSocket stream sample.

For additional CLI commands, use **CLI: Advanced Command** with a JSON argv array.
It requires explicit opt-in; credentials, hosts, TLS options, and output mode are
managed by the integration. Interactive setup/shell and MCP servers are excluded.

## References

- https://www.activepieces.com/docs/build-pieces/misc/bundling-pieces
- https://www.activepieces.com/docs/admin-guide/guides/manage-pieces
- https://docs.kraken.com/exchange/guides/rest/authentication
- https://docs.kraken.com/exchange/guides/futures/rest
- https://github.com/krakenfx/kraken-cli
