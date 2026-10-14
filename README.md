# Gitpunk

**Agents should see each other's work before it becomes a conflict.**

Gitpunk adds shared intent, live drafts and checked integration to ordinary Git. Agents use isolated Git checkouts or sparse workspaces without `.git`. One background service shares saves; three MCP tools handle everything: `work`, `status`, `respond`.

## Why

[GitHub](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent) already has coding agents, pull requests and merge queues. Gitpunk focuses on coordination **before the commit**: declared files, visible drafts, agreed contracts and explicit handoffs.

[Git AI](https://usegitai.com/) tracks AI attribution. [CodeSpeak](https://github.com/codespeak-dev/hello-codespeak) generates commits from versioned specifications. Gitpunk helps independent agents work together while preserving the intent and evidence behind their changes.

[Anthropic's scaling story](https://www.anthropic.com/engineering/redesigning-source-control) motivates the second half: fetch selected files, ask the server about history, reuse immutable objects, and check candidates concurrently. Gitpunk implements these mechanisms over Git; [local measurements and remaining scale limits](SCALING.md) are explicit.

## Features

- Signed intents with accountable human owners and scoped file permissions.
- Automatic WIP sharing, overlap warnings and durable pub/sub through Kafka and cursor polling.
- Shared decisions and pinned handoffs: code, agreed decisions and unfinished criteria.
- Ordinary Git commits, automatic uploads and peer fetch without changing staging.
- Checkout-free source queries and server commits from signed drafts; bounded shared caches.
- Optional R2 object storage and durable branch CAS; selected native Git inputs replace a full server mirror.
- Sparse, concurrent Docker checks of exact combined candidates; owner approval and ordered integration.
- Live branch board; summaries shared by default, raw prompts/context opt-in.

**Status:** working local MVP with development identities. R2/DO runs in the real local Workers runtime. The Workers/Artifacts bridge passed a separate live Git test. Cloud collaboration, production enrollment and real-model verification remain in the [roadmap](Roadmap.md). File permissions protect publication; unrestricted local agents still need a sandbox.

## Run

Node 24+, Git and running Docker are required.

```sh
npm ci
docker pull python@sha256:3dd7cc108ec1493442514f5c2a871af6af0ec31d768ff6e378a93340c3b3db5f
npm start
```

Open [localhost:8787/board](http://127.0.0.1:8787/board) and choose `.local/mvp/board.profile.json`. This starts the server, Kafka, two isolated workspaces and sync. Ctrl-C stops Gitpunk; Kafka stays running locally.

On a fresh instance, `npm run demo:mvp` shows overlap, decisions, handoff, checks and integration using scripted MCP clients. Bring your own coding agent using the generated profiles: [MVP setup](MVP.md).

For sparse workspaces, run `npm start -- --remote` and use `.local/mvp-remote/` profiles. `npm run bench:scale` compares full/partial Git clones, cached source reads and real concurrent Docker checks.

`npm start -- --objects` runs the same MVP on local R2/DO with `.local/mvp-objects/` profiles. `npm run bench:objects` tests object storage and checked integration. [Backend setup and limits](server/cloudflare/OBJECTS.md).

Development stays local. Cloudflare tests require fresh usage visibility and bounded activation: [cost rules](COSTS.md). [Submission steps](SUBMISSION.md).

## Contribute

Pick one [roadmap](Roadmap.md) step. Keep modules small, use existing Git, and avoid dependencies or features without a concrete need. Update the shared protocol and both consumers together. Add meaningful failure tests; keep credentials and private transcripts out of Git.

```sh
GITPUNK_DOCKER_TESTS=1 npm test
```

[Client contract](techdoc.md) · [Server design](server/techdoc.md) · License selection pending.
