# Kraken for Activepieces

Automate Kraken Spot and Futures workflows with market data, balances, orders,
funding, Earn, subaccounts, exports, and polling triggers. Map values from earlier
steps into named inputs, optional settings, and structured batch orders.

**npm package:** [`activepieces-piece-kraken`](https://www.npmjs.com/package/activepieces-piece-kraken)

This is an independent integration. It is not published under the
`@activepieces` npm organization and does not imply endorsement by Kraken.

## What is included

Version 0.2.4 provides **263 actions and 3 polling triggers**:

| Component | Coverage | Extra runtime required? |
| --- | --- | --- |
| 90 named native REST actions | Spot and Futures market data, account data, trading, funding, Earn, subaccounts, and reports | No |
| 2 custom API actions | Additional Spot and Futures endpoints with automatic request signing | No |
| 170 named CLI actions | Official Kraken CLI commands, including paper trading, workspaces, session/lab tools, and bounded WebSocket samples | Kraken CLI on a self-hosted worker or the supplied Docker runner |
| 1 advanced CLI action | Additional commands supplied as an argument array | Same CLI runtime requirement |
| 3 polling triggers | New Spot trade, closed Spot order, and new ledger entry | No CLI runtime; Spot API credentials required |

The native forms define 340 API fields. Available operations and permissions
still depend on the Kraken account, API key, region, and product eligibility.

Public market actions work without API credentials. Private Spot and Futures
operations use separate credentials stored in an Activepieces connection.

## Install from npm

Install the piece through the **NPM Registry** option in Activepieces:

1. Open **Install Piece**. Depending on the Activepieces version, this is under
   **Settings > My Pieces** or **Platform Admin > Catalogue > Pieces**.
2. Choose **NPM Registry**.
3. Enter the package name `activepieces-piece-kraken` and version `0.2.4`.
4. Install, then search for **Kraken** when adding a flow step.

A host-level `npm install` alone does not register the piece in Activepieces.
See the [public npm piece guide](https://www.activepieces.com/docs/build-pieces/sharing-pieces/community).

### Compatibility and the 0.86.3 installation error

The package declares Activepieces **0.82.0+** and requires **Node.js 22+** on the
worker. This declared minimum is separate from server-side registry installation
compatibility. The supplied local Docker lab is pinned to Activepieces 0.82.0;
it is not an upgrade configuration for an existing production deployment.

Activepieces **0.86.3** can fail to install a new custom npm piece with:

```text
Failed to fetch piece bundle activepieces-piece-kraken@0.2.3: 404 Not Found
```

That version can require registered metadata before downloading the bundle needed
to extract that metadata. The package and its tarball can exist on npm while the
server still returns this error. Republishing under a different name does not
resolve that server-side failure. The npm fallback is present in the 0.89.0 source;
0.92.3 also includes it. Review the
[upgrade notes](https://www.activepieces.com/docs/install/reference/breaking-changes)
before updating, and keep app and worker image versions identical.

For an unlicensed self-hosted deployment, Community Edition supports npm piece
installation. Packed archive upload is a separate paid/private-piece feature;
it is not required for the npm installation path. Switching editions removes
Enterprise-only features. From 0.87, unlicensed Enterprise instances also have
free-plan credit enforcement, so do not treat an Enterprise image update as an
edition-neutral change.

Implementation references:
[0.86.3 bundle resolver](https://github.com/activepieces/activepieces/blob/0.86.3/packages/server/api/src/app/pieces/piece-bundle.ts),
[0.89.0 bundle resolver](https://github.com/activepieces/activepieces/blob/0.89.0/packages/server/api/src/app/pieces/piece-bundle.ts),
and [Community Edition installation endpoint](https://github.com/activepieces/activepieces/blob/0.92.3/packages/server/api/src/app/pieces/community-piece-module.ts).

## Set up a connection

Open **Connections > New Connection > Kraken**, or create a connection from the
Connection selector on an authenticated action such as **Spot: Balance**.

| Connection input | When to use it |
| --- | --- |
| Spot API Key / Spot API Secret | Private Spot, funding, Earn, history, and related account actions |
| Futures API Key / Futures API Secret | Private Futures actions; these are separate from Spot credentials |
| Use Futures Demo Environment | Route Futures calls to Kraken's demo environment using demo credentials |
| My Spot API key requires a 2FA code | Only when 2FA was explicitly enabled on that API key |
| Default paper trading account | Optional named CLI workspace used by paper actions; not a Kraken subaccount |

Connection validation checks key-pair completeness and base64 secret formatting.
It does not access balances or prove that a key has permission to run every action.
Use **Spot: API Key Info**, **Spot: Balance**, or **Futures: Accounts** to check the
permissions needed by your flow.

Kraken website-login 2FA is separate from API-key 2FA. If the connection enables
API-key 2FA, affected actions expose **Current API 2FA code** under **Optional
settings**. Supply or map a fresh code for that execution. Run inputs containing
such codes should be treated as sensitive.

## Build flows with inputs

Named actions expose supported parameters directly. Required fields and common
settings appear first; **Show optional settings** reveals additional flags,
filters, and pagination inputs. Pair, asset, and contract selectors can be
searched or switched to dynamic values from earlier steps.

All named-action fields support Activepieces mapping, including complete arrays.
Batch orders use repeatable rows. Spot CLI batch orders create and remove their
own temporary JSON file inside the runner; users do not need to supply a container
path. Generic JSON inputs are available on the custom API and advanced CLI actions.

Native actions preserve Kraken's decimal strings and original field names. CLI
actions return the CLI's normalized output. Futures responses preserve operation
status: a top-level `result: success` is not proof that an order was placed or filled.
Action pagination remains under the caller's control.

### Example: price and balance

1. Start with a manual trigger.
2. Add a Code step named `inputs`, with an input `pair` set to `XBTUSD`:

   ```javascript
   export const code = async (inputs) => {
     return { pair: inputs.pair };
   };
   ```

3. Add **Spot: Ticker** and map **Trading pair** from that step's `pair` output,
   for example `{{inputs.pair}}`. This public step needs no Kraken connection.
4. Add **Spot: Balance** and select your Kraken Spot connection.
5. Test the steps. The flow reads data and does not place an order.

Use Activepieces' data selector when mapping so the expression matches the actual
internal name of your preceding step.

### Polling triggers

**New Spot Trade**, **Spot Order Closed**, and **New Ledger Entry** poll once per
minute. Enabling a trigger starts its cursor at enable time; testing fetches recent
examples. Ledger entries can include deposits, withdrawals, transfers, fees, and
rewards.

Polling fetches all pages within its window, overlaps timestamps, and deduplicates
IDs. Incomplete pagination fails without advancing the cursor. A window exceeding
the built-in 10,000-record pagination guard also fails rather than silently
skipping the remainder.

## Monthly trade and ledger exports

The native Spot export actions can produce a report for a selected month:

1. **Spot: Request Export**: select trades or ledgers, choose CSV or TSV, enter a
   description, and map the month's start/end UNIX timestamps under optional
   settings. Enable **Allow Account Changes** if required by the action.
2. **Spot: Export Status**: check the requested report type until the returned
   report ID has finished processing. Use the ID from Request Export to select
   the matching report.
3. **Spot: Retrieve Export**: map the completed report's ID. The action writes the
   ZIP download to Activepieces file storage and returns its file URL.
4. Save or send the file through another flow step. **Spot: Delete Export** can
   delete a completed report or cancel one that is still queued or processing.

For recurring reports, use a monthly Schedule trigger, calculate the previous
month's boundaries, then request, wait/check, and retrieve the report. Set the
reporting timezone deliberately when calculating timestamps. The piece supplies
these actions; a preconfigured monthly export flow is not installed automatically.

These operations need a Spot API connection with Kraken's applicable export/data
permissions, but no CLI runner. CSV/TSV trade and ledger exports are supported;
the piece does not generate the formatted PDF account statement available on
Kraken's website. See [Kraken's export report API](https://docs.kraken.com/api-reference/account-data/request-export-report).

## Native API actions versus CLI actions

**Native API actions need only the installed npm piece and any required API
credentials.** They do not need the Kraken CLI, a sidecar, or this repository's
Docker configuration. These actions can be used on an ARM64 Raspberry Pi worker
that meets the Node.js and Activepieces requirements.

**Actions prefixed with CLI execute the official Kraken command-line program.**
The npm package includes the action definitions and execution adapter, but does
not install a platform-specific Kraken executable or start a runner.

Two self-hosted execution options are supported by the adapter:

- Use the supplied Docker CLI runner, reached through `KRAKEN_CLI_BRIDGE_URL` and
  `KRAKEN_CLI_BRIDGE_TOKEN` on the Activepieces worker.
- Install a compatible Kraken CLI on the worker and expose it through
  `KRAKEN_CLI_PATH` or the worker's `PATH`. This requires a worker execution mode
  that permits the process and its runtime files.

The supplied CLI Dockerfile downloads **Kraken CLI 0.4.1 for Linux x86-64**.
It is not currently an ARM64 runner image. Running the native actions on a Pi
therefore does not imply that the supplied CLI sidecar also runs on that Pi.
An ARM64-compatible CLI build and runner setup would be needed for local CLI use.

A paper trading account is a named, local CLI workspace containing simulated
balances, orders, and strategy state. It does not choose a live Kraken subaccount.
Paper actions show the account input; live CLI account/trade actions offer an
explicit routing override under Optional settings. Ordinary market actions show
no workspace field.

CLI streams return bounded samples, not a continuously running WebSocket
subscription. Stream inputs accept 1-120 seconds and 1-1,000 events. Other CLI
actions use internal defaults and expose a timeout under Optional settings.
**CLI: Advanced Command** takes an argv array such as `["status"]` and requires
explicit opt-in. Interactive setup, shell, MCP server execution, persistent
credential changes, and credential/host/TLS overrides are excluded from flow actions.

## Account changes and shared state

Orders, withdrawals, transfers, Earn allocations, and other writes require the
**Allow Account Changes** checkbox. **Validate Order** always sets `validate=true`.
Deposit address reads always set `new=false`; creating an address is a separate
write action. Requests are not automatically retried because a timed-out write
may already have been accepted. Add an approval step when your flow needs human
review.

Use a dedicated Spot key for this integration. Nonces are monotonic and private
requests are serialized within one worker process. Multiple workers, other clients,
or concurrent native/CLI calls sharing the same key can still race. Serialize
those calls, use separate keys, or configure Kraken's nonce window appropriately.

The local CLI Docker volume is shared by flows using that runner. Use distinct
paper account names where isolation is needed. The supplied lab uses an
unsandboxed worker for a single trusted user; it is not a multi-tenant deployment.

## Develop and test locally

Run these commands from a source checkout containing this README, `compose.yaml`,
`scripts/`, and `docker/`. Those development assets are not included in the npm
runtime package.

```sh
npm ci
npm test
npm run test:live
npm run docker:setup
docker compose up -d --build
```

The CLI sidecar in this lab requires Linux x86-64 as described above. Activepieces
is exposed only on `http://localhost:8088`. Its embedded PGLite database and CLI
state use separate Docker volumes. `docker:setup` generates local secrets and
preserves existing values.

Once Activepieces has started, pack and install the piece in the local lab:

```sh
npm pack ./dist/package --pack-destination ./dist
npm run docker:install
npm run docker:test
npm run docker:test:cli
```

The installer generates local administrator credentials in `work/local-admin.json`
and stores the session in `work/ap-session.json`. These files are git-ignored and
excluded from npm. The first user registered in a fresh local instance becomes
its administrator. The installer is intended for this disposable local lab.

`npm test` builds the bundle and runs signing, validation, mapping, CLI argument,
write-control, and polling tests with synthetic credentials and mocked responses.
`test:live` calls only unauthenticated market endpoints. Docker tests exercise
flow execution, mapped inputs, paper workspace commands, and bounded stream
samples. These checks do not perform live private-account requests, real orders,
withdrawals, or transfers. Live private execution is not claimed as tested.

## Build and publish

```sh
npm run build
npm run pack:piece
```

The npm package contains a self-contained CommonJS bundle at `dist/src/index.js`
and TypeScript declarations. It has no production npm dependencies to install
at runtime. The build also prepares `dist/package` with `main: ./src/index.js`
for environments entitled to install packed archives.

For a new npm release, increment the version before publishing; an existing npm
version cannot be replaced. The publishing account must own or have access to
`activepieces-piece-kraken`.

```sh
npm version patch --no-git-tag-version
npm publish --access public
```

The publish hook rebuilds and tests the package. Documentation changes become
visible on npm when a new package version is published; editing this source
README alone does not update the existing npm release.

Publishing this independent package does not add it to Activepieces' official
catalogue. Publishing as `@activepieces/piece-kraken` requires their organization's
permission and contribution/release process.

## References

- [Publish a community npm piece](https://www.activepieces.com/docs/build-pieces/sharing-pieces/community)
- [Private archive installation](https://www.activepieces.com/docs/build-pieces/sharing-pieces/private)
- [Activepieces upgrade notes](https://www.activepieces.com/docs/install/reference/breaking-changes)
- [Kraken Spot authentication](https://docs.kraken.com/api/docs/guides/spot-rest-auth/)
- [Kraken Futures authentication](https://docs.kraken.com/api/docs/guides/futures-rest/)
- [Official Kraken CLI](https://github.com/krakenfx/kraken-cli)
- [License](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)
