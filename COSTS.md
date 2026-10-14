# Cloud costs

Keep normal development on the Mac. Cloudflare is for brief, bounded verification until a production budget is approved.

The Workers Paid subscription is $5/month **plus metered overage**. It is not a $5 spending cap. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/)

| Shared account allowance | Included monthly |
|---|---:|
| Workers requests | 10 million |
| Workers CPU | 30 million ms |
| Artifacts operations | 10,000 |
| Artifacts storage | 1 GB |

Artifacts billing begins October 14, 2026. Existing Workers share account allowances. [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)

## Gitpunk limits

- Public and preview URLs disabled by default; no schedules or continuous cloud sync.
- Bridge CPU limit: 50 ms per request. Provider operations require an unexpired test window.
- Smoke journal caps: 40 bridge attempts, 20 Git remote commands, 64 KiB of fixture writes, two synthetic repos. Counts persist before calls; retries consume the same budget.
- Tiny fixtures only. No cloud imports, model inference, builds, runners or new database/storage services during this verification.
- Revoke short-lived Git tokens and disable public URLs after each test, including failures. Read back shutdown state.
- Check account usage before enabling a test. Unknown or stale account usage is a reason to keep cloud writes off.
- Record local operation counts separately from Cloudflare's billable usage. They are not interchangeable.

## Tracking

`python3 scripts/cloudflare-usage.py` reads existing Wrangler authentication in memory and saves a sanitized snapshot under ignored `.local/cloudflare/`. It never creates resources or prints credentials. Missing permissions or delayed billing data remain `unknown`.

October 4 dashboard baseline: account usage charges $0, Workers requests 0, CPU 0 ms and no Artifacts namespaces. A $1 account usage alert was saved and verified. Wrangler billing API permissions remain unavailable; use the signed-in dashboard when API data is unknown. Daily Codex monitoring was configured at 9 a.m. local time and later removed at the owner's request. Private screenshots and sanitized receipts live in `.local/cloudflare/`.

Live verification finished within the same journal: 20 bridge attempts, 12 Git remote commands, 97 fixture bytes and two repos. All three issued tokens were revoked with fresh denials. The bridge has both URL types disabled, no routes and an empty activation window; a fresh request returned 404. The tiny repositories remain stored. No cloud sync, imports or paid execution services are running.

Post-test dashboard: $0 usage charges, 18 Workers requests and 24 ms CPU. These delayed meters differ from attempted test calls. Provider storage bytes remain unreported.

Use Cloudflare's Billable Usage page for authoritative usage-based spending. Budget alerts are delayed notifications; they do not stop usage or include subscription fees. [Billable usage](https://developers.cloudflare.com/billing/manage/billable-usage/) · [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)

The owner stopped and removed the daily cost-check automation on October 12, 2026. It remains off. Before any future cloud test, verify fresh usage manually; notify on any usage-based charge, 50% of an included allowance, an unexpectedly public Gitpunk endpoint, or loss of visibility. Leave unrelated projects under their owners' control.

October 13 release check: Wrangler authentication refreshed successfully. Billing API access remains unavailable and Workers/Artifacts analytics are empty; current costs and meters are unknown. Fresh API read-back confirmed public and preview URLs disabled and zero bridge routes. Cloud writes remain off; no resources changed.

October 14: fresh signed-in dashboard totals for the October 13–November 12 billing cycle show $0 usage charges, Workers 0 requests/0 CPU ms, and R2 0 Class A/0 Class B/0 stored bytes. Artifacts lists one namespace and the same two repos; its operation/storage meters remain unavailable. Fresh API read-back confirms both bridge URL types disabled and no routes. Sanitized receipt/screenshots are ignored under `.local/cloudflare/`. No cloud resources changed. R2/DO development and large tests run in local workerd; live use of this new backend still needs an explicit test budget and fresh relevant meters. The daily cost automation remains off.
