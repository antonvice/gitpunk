# Distributed Git objects

R2 holds immutable, compressed Git objects. A SQLite Durable Object holds the canonical head and durable compare-and-swap receipts. Gitpunk's gateway handles users, intents, permissions, Kafka and checks.

Files and trees read directly from R2 through a 32 MiB gateway cache. Git operations use a disposable promisor repository, populated with the selected objects in one batch. Native Git computes commits, merges, diffs and blame. Nothing changes Git's format or an agent's staging area.

Objects publish before admission. The gateway exposes accepted provenance only. Integration checks current authority immediately before dispatching CAS; a completed CAS has a durable receipt even if its HTTP response or local SQLite receipt is lost. Revocation cannot cancel an already-dispatched update. One gateway owns collaboration/auth state today.

## Run locally

```sh
npm start -- --objects
npm run demo:mvp -- --data-dir=.local/mvp-objects
```

This runs the actual Workers runtime, SQLite DO and R2 locally. Use `.local/mvp-objects/` profiles. It makes no Cloudflare calls. The same intent, handoff, checks and board flow runs on this backend.

```sh
npm run bench:objects
# Larger synthetic test; several minutes of local CPU and roughly 2 GiB of disk:
npm run bench:objects -- --history-gib=100 --worktree-gib=25 --dense-mib=1024 --commits=2048 --jobs=128 --seconds=120
```

Receipts stay under `.local/object-scale-*/`. History/worktree sizes are **logical uncompressed Git bytes**. Most fixture blobs compress well; `dense_blob_bytes`, compressed R2 bytes and physical runtime storage are reported separately. Throughput trials and branch-update trials are separate; neither proves 24-hour production capacity.

## Cloud setup

Read [COSTS.md](../../COSTS.md). Nothing deploys automatically. After an explicit budget and fresh account meters:

1. Create a private `gitpunk-objects` R2 bucket; deploy `objects.wrangler.jsonc` and an owner-only internal secret.
2. Set a short activation window and request/write-byte limits; use one named test repo. Keep public/preview URLs disabled except during the bounded test.
3. A private mode-0600 config contains `endpoint`, `token`, `repo` and trusted SHA-1 `base`. `importObjects` streams a trusted repo into storage before starting the gateway with `--object-config=<file>`.
4. Keep an attempt journal before provisioning or calls. Verify exact code, restart/replay and denied credentials; then close endpoints, clear activation, revoke the test secret and record current usage.

The Worker defaults to zero permitted operations. Its durable counter reserves a request and write bytes before R2/CAS. These application quotas bound test traffic; they are not a Cloudflare billing cap. Provider operation counts can differ.

## Current limits

- One configured repository/`main` branch and one collaboration gateway.
- SHA-1 Git; each object ≤4 MiB; each native operation ≤32 MiB/4,096 selected objects. History walks stop with an explicit error beyond 4,096 commits; no missing parent is treated as a root.
- Source files ≤1 MiB; text drafts ≤256 KiB. Owner-selected runner sources must fit the operation budget.
- Legacy bundle upload/export stays on the local Git backend. Artifacts remains the ordinary Git transport option; its [1 GB repository limit](https://developers.cloudflare.com/artifacts/platform/limits/) excludes a direct 100 GB monorepo.
- Cloud deployment, regional readers, path-history indexes, large objects, gateway replication and a sustained production pilot remain gates.
