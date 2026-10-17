# Kraken for Activepieces

Independent integration for Kraken Spot and Futures, funding, Earn, subaccounts,
reports, and the official Kraken CLI. Node.js 22+; Activepieces 0.82.0+.

## Coverage

- 90 native REST actions with 340 schema-defined fields, required-field validation,
  readable labels, searchable pair/asset/contract choices, and optional settings.
- Every named action accepts values mapped from preceding steps. Lists and batch
  orders use normal repeatable inputs; raw JSON is reserved for custom API calls.
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
If you explicitly enabled 2FA on the Spot API key, enable **My Spot API key
requires a 2FA code** in the connection. The affected actions then show a
**Current API 2FA code** input under Optional settings. Map a fresh code from a
preceding step. Ordinary Kraken website-login 2FA does not enable API-key 2FA.
Run input logs containing a code should be treated as sensitive.

Use a dedicated Spot key for this integration. Nonces are serialized and
monotonic inside one worker process; multiple worker processes or simultaneous
native/CLI calls sharing a Spot key can still race. Serialize those flows, use
separate keys, or configure Kraken's nonce window. CLI paper/workspace state is
persistent in the Docker volume and shared by flows on that worker; select
distinct paper trading account names where isolation is needed. This local image is intended
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

For installations that support custom pieces: Platform Admin ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Catalogue ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Pieces
ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Install Piece ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Upload File, then select the generated `.tgz`. npm publication
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

## Input-first forms (0.2.x)

Named actions expose supported API parameters directly. Required fields are
marked; common fields appear first; **Show optional settings** reveals flags,
filters and pagination without a JSON editor. Kraken choices can be searched or
switched to a dynamic value. All fields support Activepieces mapping, including
arrays from previous steps. Prices and quantities retain decimal precision.

A **Paper trading account** is a local, named Kraken CLI workspace. It groups
simulated balances, orders and strategy state. It does not select a Kraken
subaccount. It is shown on paper actions; live CLI account/trade actions offer
an explicit routing override in Optional settings. Ordinary ticker and market
actions show no workspace field. The connection can provide a default paper
account. CLI streaming actions alone show event/time limits. Other CLI actions
use internal defaults and offer a timeout under Optional settings.

Spot CLI batch orders accept repeatable order rows. A temporary JSON file is
created inside the runner and deleted after execution, so the user need not
create a file or know a container path for that operation. Old 0.1.x flow values
remain accepted, including legacy parameters, workspace and runtime inputs.

The Docker smoke flow includes a Set Kraken input values step. Spot ticker maps
its pair from that step, and CLI ticker maps the complete list of pairs.
