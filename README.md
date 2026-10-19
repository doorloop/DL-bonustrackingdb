# CSM Bonus Tracking Dashboard

Built for [GTM-2495](https://linear.app/doorloop/issue/GTM-2495) — lets CSMs see their bonus
progress (logo churn, conversions, QBR coverage, NPS, meaningful connections, save rate, CSAT)
in one place. The Salesforce field/object mapping behind these queries is tracked in
[GTM-2496](https://linear.app/doorloop/issue/GTM-2496); this README mirrors that mapping so it
doesn't drift out of sync with the code.

## Getting started

```bash
npm install
cp .env.example .env.local   # defaults to mock data — see below
npm run dev
```

By default (`USE_MOCK_DATA=true` or no Salesforce credentials set) the dashboard serves mock
metrics so the UI is usable before the Salesforce connection exists.

## Salesforce connection

**This app must use its own read-only integration user — do not reuse the `salesforce` repo's
CI deploy credentials.** That repo's CI authenticates via OAuth 2.0 Client Credentials against an
External Client App (ECA) that has metadata-deploy rights to prod (see its
`.github/workflows/_deploy.yml`). Wiring that same client id/secret into this dashboard would mean
a compromised dashboard could deploy/modify Salesforce metadata — exactly the blast radius the
`salesforce` repo's dual-instance MCP design (`docs/mcp-safety.md`) exists to prevent.

Instead, set up a **separate, read-only** integration:

1. In Salesforce Setup, create a new External Client App (or Connected App) scoped to this
   dashboard only, with the **OAuth 2.0 Client Credentials flow** enabled (same flow style as CI,
   different app).
2. Create a dedicated **run-as integration user** on a permission set that grants:
   - API access + a **read-only** profile (no CRUD, no metadata scope)
   - Query/read access to: `Account`, `MRR_Change__c`, `CX_Event__c`, `NPS_Score__c`,
     `DoorLoop_Cancelation_Request__c`
3. Fill in `.env.local`:
   ```
   SF_INSTANCE_URL=https://doorloop.my.salesforce.com
   SF_CLIENT_ID=...
   SF_CLIENT_SECRET=...
   USE_MOCK_DATA=false
   ```

Optional env vars:

| Var | Default | Purpose |
|---|---|---|
| `BONUS_TARGETS` | `{"logoChurn":2,"netConversions":10,"qbrCoverage":80,"nps":50,"saveRate":60,"csat":4.5}` | Comp-plan targets (placeholders — they are not in Salesforce). Any subset of keys overrides the defaults. |
| `CSAT_SURVEY_ID` | `CX-CSAT` | `CX_Event__c.Survey_Id__c` value that identifies the CSAT survey. |

The page and `/api/metrics` default to quarter-to-date and accept `?quarter=-1` (previous
quarter) or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (`to` is exclusive). Each metric loads
independently: a query that fails (e.g. the run-as user can't read an object) shows its error in
that section instead of failing the whole page.

`lib/salesforce.ts` handles the token exchange and SOQL queries; `lib/metrics.ts` has one query
per metric.

## Deploybay

The `deploybay` connector wasn't authorized when this repo was scaffolded, so
`.github/workflows/deploy.yml` only builds — it doesn't ship anywhere yet. Once `deploybay` is
connected, pull its platform guide and fill in the actual deploy step (see the TODO in that file).

## Metric → Salesforce mapping (GTM-2496)

| Metric | Object / fields | Status |
|---|---|---|
| Logo churn per CSM | `Account.Vitally_Assigned_CSM__c` grouped, filtered on `Account.Stripe_Subscription_Canceled_At__c` in-window, excluding never-billed accounts (`Stripe_Subscription_First_Invoice_At__c = null`, i.e. lapsed trials) and accounts that came back (`Stripe_Subscription_Status__c` in `active`/`trialing`) | **Confirmed** — "locked as of Oct 1" = `Stripe_Subscription_Canceled_At__c` populated (confirmed 2026-09-28). The two exclusions match the CX capacity planner's churn model (2026-10-19) |
| Net monthly ↔ annual conversions | `MRR_Change__c.Starting_Price_Interval__c` / `Ending_Price_Interval__c` (`month`/`year`) | **Confirmed** — object purpose-built for this |
| QBR coverage | % of the CSM's active book (`Account.Account_Status__c = 'Active Customer'`, attributed by the CSM rule) with ≥1 `CX_Event__c` where `Event_Category__c = 'Account Review'` ("Business Review with DoorLoop", confirmed 2026-09-28) completed in the window. Book is today's snapshot (no assignment history in SF). | **Confirmed field, no data** — as of 2026-10-01 no `CX_Event__c` has ever been logged as `Account Review`; CS calls are logged as `Customer Success`. The tile reads empty until QBRs are logged under that category. |
| NPS | `NPS_Score__c.Score__c` (child of Contact via Master-Detail `Contact__c`; NPS = %promoters 9–10 − %detractors 0–6, not an average; filtered on `Date__c` = send date; onboarding NPS on `Onboarding__c.Onboarding_NPS_Score__c` excluded), joined `Contact__r.Account.Vitally_Assigned_CSM__c` (Contact→Account is the standard `AccountId` lookup) (⚠️ `NPS_Score__c.User__c` is the outreach caller, not the CSM — never group by it; `Score__c` is `Number(2,0)` and SOQL can't `GROUP BY` a number field, so the code runs three grouped counts: all / ≥9 / ≤6) | **Confirmed source; pipeline mid-migration** — GTM-2512 (Intercom→Salesforce automation) is still open, so coverage is partial/manual until it ships |
| Meaningful connections / Zoom minutes | Candidates: `CX_Event__c.Meeting_Actual_Duration__c` or `ZVC__Zoom_Call_Log__c.Call_Duration_Minutes__c` (the latter is Zoom **Phone**, likely the wrong object) | **Gap — unresolved.** [GTM-2515](https://linear.app/doorloop/issue/GTM-2515) is open specifically to define this metric and its source. Do not ship either candidate as the real metric until that closes. |
| Save rate | `DoorLoop_Cancelation_Request__c.Status__c = 'Saved'` over all rows with `Assigned_To__c` populated in-window | **Confirmed** — matches the existing `Open_Saves_by_Owner` / `Cancel Requests This Month by Outcome` reports in the salesforce repo |
| CSAT | `CX_Event__c.Survey_Rating__c` (1–5 scale) **filtered by `Survey_Id__c = 'CX-CSAT'`** — never aggregate this field across survey types | **Confirmed, sparse** — one response in prod as of 2026-10-01 |

**CSM attribution rule** (confirmed 2026-09-28): every per-CSM metric goes to the account's
current `Vitally_Assigned_CSM__c`; if empty, to `Vitally_Temporary_CSM__c`. Churn counts for the
current CSM (not `Previous_CSM__c`). Save rate is the exception — it's grouped by the cancellation
request's `Assigned_To__c`.

If any of these objects/fields change, the source of truth is the `salesforce` repo's
`force-app/main/default/objects/` metadata (that repo is `git == prod` for the org) — re-derive
the mapping from there, not from this table.

## Stack

Next.js 15 (App Router) + TypeScript, no UI framework dependency. Palette/status colors follow
the validated accessible palette in this workspace's `dataviz` design skill (categorical blue,
status good/warning/serious/critical) — see `app/globals.css`.
