# Agent-scale Gitpunk

Gitpunk addresses checkout traffic, duplicated objects, expensive client operations, full server copies and serial checks while keeping ordinary Git. Its R2/DO backend is implemented and measured in local workerd. Production Scion-scale qualification remains open.

## What works

| Bottleneck from [Anthropic's article](https://www.anthropic.com/engineering/redesigning-source-control) | Gitpunk mechanism | Boundary |
|---|---|---|
| Every online agent copies repository history | Optional remote workspace: no `.git`; only declared baseline files download | Ordinary Git checkouts remain supported |
| Jobs clone just to ask about source | Authorized file, tree, diff, merge-base/ancestry, history and blame APIs | Git computes uncached history on the server |
| Identical objects download repeatedly | Immutable Git IDs; bounded shared server memory and node disk caches; coalesced server misses | Two local cache levels; no regional fleet yet |
| Large pack negotiation for small tasks | Selected manifests and exact blobs; restartable per-file downloads | API files ≤1 MiB; text drafts ≤256 KiB |
| Clients create and upload commits | Agent signs exact drafts/request; server writes changed blobs/trees and a Git commit | Git directory trees still cost their size; SQLite serializes metadata admission |
| CI materializes unrelated source | Owner-pinned `source_paths`; batched blob reads; no Git checkout/index in runners | Owner must include the check's dependencies |
| Work waits behind other checks | Concurrent checks of a bounded FIFO candidate prefix; short ordered CAS integration | Failed/changed prefixes recheck; approval stays explicit |
| Monorepo permissions | Source reads and writes enforce path scope; cached reuse reauthorizes | Downloaded bytes cannot be recalled; local agents need isolation |
| Full server mirrors outgrow a node | R2 compressed objects; direct reads; disposable, batched native Git inputs; DO conditional heads | Real local runtime proof; one collaboration/auth gateway; cloud deployment remains gated |

Intents, signed WIP, Kafka/cursor pub/sub, decisions, handoffs and exact approvals remain intact. Legacy Git upload/fetch uses the local Git backend; R2 uses signed drafts/source APIs. Accepted commit IDs are indexed; arbitrary objects and unadmitted refs are unreadable. Status calls do not build bundles.

Server-created commit provenance is precise: the agent signed the request and content hashes, while the server chose the Git commit ID. A legacy fetch verifies those signatures, the authenticated manifest, bundle hash and actual Git diff.

## Run

```sh
npm start -- --remote
# Another terminal, on the fresh starter:
npm run demo:mvp -- --data-dir=.local/mvp-remote
# Independent local benchmark; pinned Docker image must already be available:
npm run bench:scale
```

Use generated `.local/mvp-remote/` profiles and the same three MCP tools. Declare work, call `prepare_write`, edit, wait for draft publication, then `respond({action:'commit', message:'...'})`. A commit does not mean checked or integrated.

`status({source:{action:'file', commit, path}})` reads pinned source without a clone. `respond({action:'source_snapshot', commit, paths})` creates a fresh selected snapshot. New tasks preserve the workspace's own base, like a Git checkout; canonical updates remain visible through status and source queries without overwriting local edits.

## Local measurements

October 14, 2026; Node 26.3.0 / Apple Git 2.50.1; one Mac. Latest completed run:

| Eight jobs read the same 4,622-byte file | Total time | Retained workspace bytes |
|---|---:|---:|
| Full Git clone via upload-pack | 6.738 s | 269,012,800 |
| Native Git partial clone + sparse checkout | 1.256 s | 483,240 |
| Gitpunk, cold shared node cache | 0.315 s | 36,976 |
| Gitpunk, warm shared node cache | 0.161 s | 36,976 |

Gitpunk's shared cache additionally retained 4,622 bytes. Cold API responses totaled 8,237 JSON bytes, including one file download; warm responses totaled 1,856 bytes and downloaded no file contents. Every job verified the same SHA-256. Git wire traffic was not measured: retained bytes are storage, not bandwidth.

Fixture: 32 history commits, 16 MiB of deterministic unrelated binary source, eight jobs. Both Git baselines use `file://` upload-pack, avoiding hard-link clones; partial-clone filtering is enabled on the trusted fixture server. Server storage/setup is excluded from all timings. OS/Docker caches are not reset; order is fixed. These are small local trials, not production capacity estimates.

| Eight exact candidates, real Docker contract checks | Serial | Four workers |
|---|---:|---:|
| Latest run | 8.598 s | 4.131 s |
| First run | 10.336 s | 4.239 s |

Each run integrated all eight changes once, preserved their content and bound evidence to target/candidate/image/policy. Each check exported 470 bytes from the owner-selected `parts` and `tests` directories instead of the unrelated 16 MiB. The contract performs real assertions and a 600,000-iteration checksum; no sleeps or mock runner are used. Four workers allow four CPUs/512 MiB of container memory at once. Benchmark approval is explicitly automatic; the MVP default is manual.

The benchmark saves full private receipts under ignored `.local/scale-*/receipt.json`. No Cloudflare writes or model calls occur. The independent checkout-free MCP/Kafka/Docker example also integrated a two-file handoff with its agreed decision and owner approval; save-to-peer time was 1.436 s. These agents and approvals were scripted.

## Scale gate

The full server mirror is removed in the R2 option. Local workerd tests verify two-agent integration, restart persistence, missing receipts, denied unadmitted objects, revocation on cached reads, racing CAS and a durable request quota. The MCP/Kafka/Docker handoff also ran on this backend; save-to-peer time was 1.756 seconds.

## Larger object-backend trial

October 14, one Mac, local workerd/R2/SQLite DO, native Git and real Docker. [Public receipt](examples/benchmarks/r2-local-100gib.json).

| Measurement | Result |
|---|---:|
| Distinct logical history / latest worktree | 100 GiB / 25 GiB |
| Initial history commits / stored objects | 2,053 / 53,394 |
| Random, incompressible blob data | 1 GiB |
| Compressed R2 object bytes / runtime disk | 1.182 GB / 1.203 GB |
| Selected read p50 / p95, 32 requests | 1.79 / 2.50 ms |
| Checked integrations, two concurrent scripted clients | 128 in 104.31 s; 1.23/s |
| Full pipeline object reads / largest temporary Git cache | 1.45 MB / 43,445 bytes |
| Persistent server Git copy | 0 bytes |
| Conditional branch updates + receipt reads | 27,575 in 120 s; p95 7.06 ms |

Every accepted change survived in the canonical files. Checks export only `parts`, parse the Python source and calculate a 600,000-iteration checksum. Approval is explicitly automatic for this benchmark. Branch-update throughput excludes merge computation and CI; the checked-integration row includes intent, draft, server commit, Docker and admission.

A follow-up [history receipt](examples/benchmarks/r2-history-2053.json) walked all 2,053 initial commits: cold path history took 3.36 s; ancestry and blame matched the original source. The three warm history/ancestry/blame calls together took 1.79 s. Only 508 KB of object data was read; temporary Git storage peaked at 433 KB. Subsequent warm history caching skips graph hydration.

This fixture has **100 GiB of logical Git blob history**, mostly zeros with unique prefixes. It is not 100 GiB of physical, incompressible history. R2 storage compression, physical storage, and the 1 GiB dense portion are explicit. The short rate exceeds 30,000/day's average arrival rate, but does not establish daily production capacity, representative CI, regional latency or failure behavior. Both clients and approvals are scripted; no models or cloud services were called. Cache entry/metadata improvements after the throughput run are noted in its receipt.

Reproduce with the pinned Docker image available:

```sh
npm run bench:objects -- --history-gib=100 --worktree-gib=25 --dense-mib=1024 --commits=2048 --jobs=128 --seconds=120
```

Before claiming Anthropic-scale readiness: deploy under an approved budget; test dense physical history, larger objects/history indexes, regional readers, multi-node authorization/recovery and a sustained representative 30,000 checked merges/day. [Backend limits](server/cloudflare/OBJECTS.md) · [Roadmap](Roadmap.md).
