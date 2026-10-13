# Artifacts bridge

Internal Worker adapter for the trusted Gitpunk server. The local SQLite coordinator still uses local bare Git. The adapter is deployed and live-verified; it is not wired into cloud collaboration yet.

**Verified:** seven mocked-binding scenarios, generated binding types, deployment and real create/fork/push/clone. Exact commit and binary read-back matched; read-only and fork credentials could not modify canonical code. All three issued tokens were revoked and fresh requests denied. Public/preview URLs are now disabled, no routes remain and the lease is cleared. **Unverified:** remote import and the production collaboration coordinator.

## API

Send HTTPS `POST /artifacts`, `Content-Type: application/json`, and `Authorization: Bearer <internal secret>`. The secret must contain 32–512 non-whitespace characters. Missing configuration denies every request. Only tests can enable loopback HTTP.

| `action` | Required fields | Result |
|---|---|---|
| `create` | `name` | Repository metadata, default branch `main` |
| `import` | `name`, `source_url` | Repository metadata |
| `fork` | `repo`, `name` | Repository metadata |
| `info` | `repo` | Fresh metadata |
| `read_commit` | `repo`, `commit` | Metadata for exact SHA-1 |
| `read_file` | `repo`, `commit`, `path` | Base64 bytes, SHA-256, MIME type |
| `mint_token` | `repo`, `scope`, `ttl` | Token ID, plaintext, expiry |
| `revoke_token` | `repo`, `token_or_id` | Revocation boolean |

Optional fields: `description` for create/import/fork; `source_branch` and `depth` for import; `expected_sha256` for read_file.

Requests are limited to 16 KiB, files to 1 MiB. Commits require lowercase 40-character hashes; file paths forbid traversal and `.git`. Imports require HTTPS, an administrator-allowed host, and no embedded credentials/query parameters. Scope must be explicit `read` or `write`, TTL 60–3600 seconds. There is no deletion operation. Authenticated token revocation remains available after the test window expires so cleanup can finish.

The caller must enforce user/run/repository permissions before using this adapter. Keep its secret on the trusted server. Artifacts write credentials cover whole repositories: issue agent write tokens for isolated forks; reserve canonical write access for the integrator. Responses are uncached; provider exception text and initial credentials are excluded.

Create/import/fork revoke the provider's initial token before returning metadata. `created_needs_reconciliation` means provisioning succeeded but credential cleanup did not. Preserve the requested name, inspect that repository and reconcile its tokens through the account before retrying. A lost response also needs same-name reconciliation. Do not invent another name or assume rollback; this adapter has no durable provisioning journal.

## Account setup

Use authenticated Wrangler with the intended account. The current development account is authenticated; fresh billing/usage visibility remains required before a live test.

The owner upgraded to Workers Paid. `gitpunk-artifacts-bridge` and two synthetic repos in `gitpunk-dev` now exist. The successful smoke used 20 bridge attempts, 12 Git remote commands and 97 fixture bytes, including retries. Counts are test budgets, not billable meters. Private deployment, smoke and dashboard receipts are in `.local/cloudflare/`. Read [COSTS.md](../../COSTS.md) before enabling cloud writes.

From the project root, after checking fresh account usage:

```sh
npx wrangler whoami
npx wrangler artifacts namespaces list --json --config server/cloudflare/wrangler.example.jsonc
npx wrangler deploy --config server/cloudflare/wrangler.example.jsonc --secrets-file .local/cloudflare-secrets.json
```

Pin the intended `account_id` and namespace in the config first. Keep `GITPUNK_INTERNAL_TOKEN` in an ignored, mode-0600 JSON secrets file with a random value of at least 32 characters. Code and secret deploy together; `secret put` itself deploys a version. [Secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/)

The example defaults to `workers_dev: false`, `preview_urls: false` and `limits.cpu_ms: 50`. For a brief test, set an explicit `GITPUNK_ENABLED_UNTIL` timestamp and temporarily enable `workers_dev`; restore both URL flags and clear the timestamp afterward. An expired or missing window denies provider operations.

Run `npm run demo:cloudflare -- --config .local/cloudflare/config.json` with a private ignored JSON containing `worker_url`, `account_id`, `namespace` and `internal_token`. It verifies ordinary Git push/clone, exact binary read-back, fork isolation and token revocation. Its stable journal caps calls and bytes across retries; failed creation needs same-name reconciliation. It does not disable the Worker endpoint itself: deployment cleanup must do that. Newly enabled routes may need a brief propagation delay; probes consume the same budget.

`gitpunk-dev` is the example namespace. Artifacts creates a missing namespace on the first repository creation; no separate namespace creation is required. [Namespace documentation](https://developers.cloudflare.com/artifacts/concepts/namespaces/)

Validation without deployment:

```sh
node --test server/cloudflare/worker.test.js
npx wrangler deploy --dry-run --config server/cloudflare/wrangler.example.jsonc --outdir .local/cloudflare-build
```

The adapter follows the current [Workers binding API](https://developers.cloudflare.com/artifacts/api/workers-binding/), including disposable repository handles and explicit token operations. No Cloudflare resources were provisioned during these checks.
