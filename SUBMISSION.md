# Competition submission

Deadline: **October 14, 2026, 11:59 p.m. PDT**. Submit manually at [Cloudflare's form](https://www.cloudflare.com/git-competition/submit/). The [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) prohibit automated entry; the entrant must confirm eligibility and accept the terms.

## Release checklist

- Public source with MIT, Apache-2.0 or BSD 2-/3-Clause LICENSE.
- Run instructions: [README](README.md), [agent setup](MVP.md).
- 5–10 minute MP4/WebM/MOV demo, at most 2 GiB.
- Workers and Artifacts used in the project; demonstrate concurrent agents.
- Team/contact/location and at least one attendee's name/email. Legal US/Canada residency and age 18+ are required; review the full rules yourself.

The local MVP and the Artifacts bridge work separately. Connecting the demo's working repositories to Artifacts and verifying real agents remain open. Do not describe the coordinator as Cloudflare-hosted or claim scripted clients are LLMs.

## Cloudflare work before recording

1. Wrangler authentication works after the October 13 refresh. No new account or plan upgrade is needed. Use `npx wrangler login` only if it expires again; keep credentials out of chat/Git.
2. Establish fresh account-wide Billable Usage, Workers requests/CPU and Artifacts usage in the signed-in dashboard, or provide a private token with the necessary read permissions. The current billing API lacks access and analytics are empty; those values are unknown. Old dashboard totals are historical.
3. Finish [roadmap step 2](Roadmap.md) locally, then verify it using the existing bridge and tiny fixtures. Reuse the persistent request/byte journal. Extra resources, continuous traffic or larger limits require an explicit budget.
4. During a brief approved test, activate only the Gitpunk bridge with its expiry window. Afterward revoke issued Git tokens, clear activation, disable public/preview URLs and verify no routes remain.

See [bridge setup](server/cloudflare/README.md) and [COSTS.md](COSTS.md). The $5 plan and $1 alert do not cap spending. No additional plan upgrade is needed for the local MVP. Hosted coordination, cloud runners and production Kafka are later work.

October 13 read-back: the Gitpunk bridge has public and preview URLs disabled and zero routes. No cloud resources were changed during release preparation.

## Suggested 7-minute demo

| Time | Show |
|---|---|
| 0:00–0:45 | Intent-first collaboration; explain the ordinary Git boundary. |
| 0:45–2:00 | Two isolated agents declare overlapping work; the second sees a blocker and the first save appears on the board. |
| 2:00–3:00 | Agree on a CRUD contract; hand off exact code, decisions and unfinished criteria. |
| 3:00–4:30 | Normal commit, automatic upload, combined Docker checks and explicit owner approval. |
| 4:30–5:30 | Clean combined code fails a contract; canonical code stays intact, then repair passes. |
| 5:30–6:30 | Workers/Artifacts transport with exact commit read-back and token revocation. Show the integrated flow only after verifying it. |
| 6:30–7:00 | Protected-path denial, reconnect and honest remaining scope. |

Use a fresh `.local/mvp-recording` directory; preserve the existing MVP. Label scripted demonstrations. Keep signing keys, run tokens, private prompts and account billing details out of the recording.

## Form draft

**Project:** Gitpunk

**Vision:** Coding agents should see each other's work before it becomes a conflict. Gitpunk keeps ordinary Git and adds required intent, live signed drafts, overlap acknowledgement, shared decisions and pinned handoffs. Combined candidates must pass isolated checks and exact owner approval before integration.

**Cloudflare use:** An internal Worker uses the Artifacts binding to manage Git repositories, isolated forks and expiring repository credentials. Live tests verified push/clone, exact commit and binary read-back, fork isolation and revocation. Collaboration and checks currently run locally. Update this paragraph after the combined Artifacts workflow is verified.

**Repository:** https://github.com/antonvice/gitpunk

**Run:** Follow README.md: Node 24+, Git, Docker; `npm ci`, pull the pinned Python image, then `npm start`. Open the board and load the generated private profile. MVP.md explains agent configuration and the scripted example.

Upload the video, paste the source/run details, fill your team information, review the two required confirmations, and submit once. Save the form's successful receipt. Code publication does not submit an entry.
