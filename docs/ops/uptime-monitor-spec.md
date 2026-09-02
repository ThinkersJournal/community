# External Uptime Monitor — Spec

**Status:** Spec for founder to stand up. The monitor account/setup is a founder
step (external SaaS signup); this document is the exact configuration to enter.

**Author:** controller agent, 2026-09-02, dispatched by the portfolio PM.

**Why external:** the platform already has an in-Worker DB probe writing health
to a dedicated KV namespace, surfaced at `/health/db` (see [[deploy-state]]). What
it lacks is something *off Cloudflare and off Neon* to watch that endpoint and
**alert a human** — the DB was once down ~3 days undetected. An external monitor
shares no failure mode with what it watches and owns the alerting channel the
founder otherwise lacks.

---

## 1. What to monitor

**Primary check — the production public path:**
```
GET https://community.thinkersjournal.com/health/db
```
This is what real visitors traverse (web Worker → api service binding →
Hyperdrive → Neon), so a 200 here proves the whole spine. It is a **superset**:
it also catches a custom-domain / DNS / zone failure that a workers.dev check
would miss.

**Optional secondary check — the DNS-independent path:**
```
GET https://thinkersjournal-web.ciresnave.workers.dev/health/db
```
Add this as a second monitor to **disambiguate**: if primary fails but secondary
passes, the app/DB is healthy and the fault is the custom domain / DNS. If both
fail, it's the api or the DB. Not required, but cheap and it turns one bit
("something's down") into two ("what's down").

---

## 2. Alert condition

**Alert on any non-`200` response, or on connection failure/timeout.** The
endpoint is deliberately designed for a dumb status-code monitor:

| Response | Meaning | Monitor should |
|---|---|---|
| `200` | `status:"ok"` — probe fresh, DB reachable | pass |
| `503` | `stale` / `down` / `unknown` — probe failing or older than 7 min | **alert** |
| timeout / connection refused / DNS failure | endpoint unreachable | **alert** |
| any other (`5xx`, `4xx`) | misconfiguration or outage | **alert** |

Do **not** parse the body for the pass/fail decision — the status code already
encodes it (503 on any non-healthy state). A body keyword assertion on
`"status":"ok"` may be added as an optional second layer if the provider supports
it (belt-and-suspenders against a 200 with an unexpected body), but it is not
required.

The endpoint is `no-store` / `markPrivate`, so the monitor always sees live
status, never an edge-cached value.

---

## 3. Cadence and threshold

- **Poll interval: 3–5 minutes.** Free tiers commonly floor at 5 min; that is
  fine.
- **⚠️ The pairing rule — do not tune one side without the other.** The in-Worker
  probe's staleness threshold is **7 minutes** (`staleAfterMs: 420000`). A
  ~5-minute external poll sits *inside* that window, so a genuinely stale probe is
  caught on the first or second poll. If you ever shorten the poll well below
  ~5 min you gain nothing (the probe only refreshes every 2 min via cron); if you
  ever lengthen the staleness threshold, lengthen or re-reason the poll to match.
- **Confirmations before alerting: 2 consecutive failures.** One failed poll can
  be a transient network blip from the monitor's vantage; requiring two (≈ one
  poll interval apart) removes flap without materially delaying a real outage.
  Set to 1 if you prefer fastest-possible notification and can tolerate rare
  false pages.

---

## 4. What a page actually means

A non-200 can be: DB down, api unreachable, Hyperdrive/Neon credential desync
(the 2026-08 outage class), the custom domain/DNS broken (primary check only),
**or the cron probe itself stopped** (staleness → 503). The monitor cannot and
should not distinguish these — **all of them need a human**, which is the point.
A stopped cron alerting is the heartbeat working as intended, not a false
positive.

---

## 5. Provider recommendation

**UptimeRobot** or **Better Stack (Uptime)** — both have a free tier, both have a
**mobile push app**, which resolves the founder's open "no good alert channel"
problem (Facebook Messenger was ruled out as API-hostile in [[deploy-state]]).
The mobile app is the alerting channel; no email/SMS wiring required to start.

Minimal setup:
1. Create one HTTP(S) monitor, URL = the primary in §1, interval 5 min.
2. Alert condition = status code is not 200 (or "keyword `status":"ok"` not
   present, if using the optional body layer).
3. Confirmations = 2.
4. Install the provider's mobile app and enable push notifications.
5. (Optional) add the secondary monitor from §1 for disambiguation.

---

## 6. One-time proof it actually pages

An always-green monitor is worse than none. After setup, confirm it can *fire*:
the in-Worker probe's reddening was already verified end-to-end (writing a
synthetic `ok:false` to the HEALTH KV → `/health/db` returns 503 → the `*/2` cron
self-heals it; see [[deploy-state]] for the exact `wrangler kv key put` command).
Trigger that once with the monitor live and confirm the phone actually buzzes,
then let the cron restore green. That closes the loop: probe reddens → endpoint
503s → monitor pages → human notified.
