# Client

Local Node.js client. Three commands; ordinary Git remains unchanged.

The [MVP launcher](../MVP.md) starts background sync and generates a per-agent profile. Use `--profile .local/mvp/alice.profile.json` or `GITPUNK_PROFILE` to avoid repeating connection options. Its stdio MCP adapter at `client/mcp.js` exposes work/status/respond to coding agents; signing credentials remain local.

```sh
gitpunk start --credentials .local/dev-credentials.json --identity alice --workspace /path/to/clone
gitpunk work "Add car model" --files models.py services.py --credentials .local/dev-credentials.json --identity alice --workspace /path/to/clone
gitpunk status --json --credentials .local/dev-credentials.json --identity alice --workspace /path/to/clone
```

`start` runs in the foreground. It scans accepted text-file scope, debounces saves, signs immutable checkpoints and publishes them. Cursor polling receives branch events. SQLite inbox/outbox state lives outside `.git`; delivery and agent acknowledgement are separate. Retries reuse signed event IDs. Source files and Git staging are never changed by sync.

`start --upload` opts this workspace into automatic committed-code upload; `start --no-upload` disables it and pauses queued uploads. The setting survives restart. Exact committed blobs and modes form a signed manifest; a bounded Git bundle carries those objects to the local server. Unstaged drafts stay separate. Upload is explicitly **unverified** and does not update the canonical branch. The local server needs a trusted `--git-source` baseline.

Agents can `respond({action:'fetch_commit',commit_id})` to fetch an uploaded commit into `refs/gitpunk/peers/<id>`. The client verifies its signature, bundle hash and actual file manifest; HEAD, index and working files stay unchanged. CLI uses the same `work --respond response.json` operation.

Sync automatically fetches accepted peer uploads touching the current intent's files into those private refs. Unrelated uploads stay in the inbox. Pending downloads persist alongside the receipt cursor and retry after reconnect; receiving an event never silently applies its code. `status` exposes pending downloads and exact checked/integrated evidence for the client's own uploaded commit.

Canonical updates are fetched into `refs/gitpunk/targets/<branch>` too. This includes combined merge candidates absent from individual agent bundles. The authenticated server snapshot supplies the exact SHA, original baseline, bundle hash and file manifest; the client verifies all of them. `status.target` exposes fetched or pending state. Fetching never applies canonical changes to local work.

Agent API: `GitpunkClient.create(options)`, `work(intent)`, `status()`, `respond(action)`. Responses include overlap, decisions and exact checkpoint handoffs. CLI responses use `work --respond response.json`. Handoff import requires clean work, restores all pinned files on an isolated branch, and validates content hashes. It never silently rebases local work.

Before editing, call `respond({action:'prepare_write', files:['models.py']})`. It refreshes authenticated state and returns a bounded briefing: relevant peers, latest checkpoint IDs/hashes, agreed decisions, current file permissions and canonical target. It rejects stale or queued intents, expired claims, unresolved overlaps and denied permissions. Receipt backlog and omitted context are explicit. It does not publish, acknowledge events or edit Git/files. This is a snapshot; managed agent tool interception and filesystem containment remain planned.

Production credentials use `--run ID --token-file FILE --key-file FILE --server HTTPS_URL --repo ID`. Keys/tokens stay outside Git and are not printed. `--state-dir DIR` isolates test data. HTTP is allowed only on loopback; local development has no TLS claim.

Implemented scope: signed intent/WIP publish, polling, durable retry/receipt, lease renewal, pre-write briefings, ordinary commit observation, opt-in local Git-bundle upload/fetch, decisions, handoffs, automatic relevant peer fetch and exact checked/integrated status. Wiring the verified Artifacts transport, binary WIP, coding-agent containment and live model adapters remain planned. Filesystem safety checks prevent ordinary symlink imports; unrestricted local agents still require a sandbox for containment.
