// SOQL for each GTM-2496-mapped metric, plus mock fallbacks so the dashboard
// runs before the read-only integration user exists. Field names below are
// confirmed against the salesforce repo's metadata (force-app/main/default/objects)
// as of GTM-2496 — re-verify against that repo if these objects change.
import { soqlQuery, usingMockData } from "./salesforce";
import { POOL, teamOf } from "./teams";

export interface CsmMetric {
  csm: string;
  value: number;
  target?: number;
  // Optional context line under the value, e.g. "12 of 40 accounts".
  detail?: string;
  // Raw numerator/denominator behind a ratio metric, so team totals can be
  // pooled (sum of parts) instead of averaging per-CSM percentages.
  parts?: { num: number; den: number };
  // Upgrades / downgrades behind a net figure (monthly <-> annual).
  breakdown?: { up: number; down: number };
  // Dollar amount behind the metric, e.g. ARR lost to churn.
  arr?: number;
  status: "good" | "warning" | "serious" | "critical";
}

// One dashboard section. A failed query fills `error` instead of failing the
// whole page, so one missing permission doesn't blank every other metric.
export interface MetricSection {
  rows: CsmMetric[];
  error?: string;
}

export interface BonusMetrics {
  logoChurn: MetricSection;
  netConversions: MetricSection;
  qbrCoverage: MetricSection;
  nps: MetricSection;
  meaningfulConnections: { note: string; candidates: string[] };
  saveRate: MetricSection;
  csat: MetricSection;
  windowStart: string;
  windowEnd: string;
  attribution: Attribution;
  targets: Targets;
  cleanup: CleanupRow[];
  // Account field the churned-ARR figure came from; null if none was readable.
  churnArrField: string | null;
  generatedAt: string;
  source: "salesforce" | "mock";
}

export function statusFor(value: number, target: number): CsmMetric["status"] {
  const pct = target === 0 ? 1 : value / target;
  if (pct >= 1) return "good";
  if (pct >= 0.85) return "warning";
  if (pct >= 0.6) return "serious";
  return "critical";
}

// For metrics where LOWER is better (e.g. logo churn count vs. a cap) —
// meeting or beating the cap is "good"; status only degrades once value
// exceeds target.
export function statusForLowerIsBetter(value: number, target: number): CsmMetric["status"] {
  if (value <= target) return "good";
  const pct = target / value;
  if (pct >= 0.85) return "warning";
  if (pct >= 0.6) return "serious";
  return "critical";
}

// --- Confirmed queries (GTM-2496) ---------------------------------------

// SOQL rejects a bare date literal against a DateTime field, so DateTime
// filters (CreatedDate, *_At__c) need a full timestamp. Periods start at
// midnight US Eastern (DoorLoop's reporting timezone), so the dashboard
// matches Salesforce reports, which show dates in Eastern. The offset is
// worked out per date so DST is handled (-04:00 summer, -05:00 winter).
// Date fields (NPS_Score__c.Date__c, Requested_On__c) take YYYY-MM-DD as-is.
const REPORTING_TZ = "America/New_York";

function easternOffset(date: string): string {
  // 05:00 UTC is local midnight under EST and 01:00 under EDT — both before
  // the 02:00 switch, so DST-change days get the offset in force at midnight.
  const probe = new Date(`${date}T05:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: REPORTING_TZ, timeZoneName: "longOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT-04:00"
  const m = name?.match(/GMT([+-]\d{2}:\d{2})/);
  return m?.[1] ?? usEasternFallback(date);
}

// US rule, in case the runtime lacks timezone data: EDT from the second
// Sunday of March through the day before the first Sunday of November.
function usEasternFallback(date: string): string {
  const [y = 1970, mo = 1, d = 1] = date.split("-").map(Number);
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const day = Date.UTC(y, mo - 1, d);
  const dstStart = Date.UTC(y, 2, nthSunday(2, 2));
  const dstEnd = Date.UTC(y, 10, nthSunday(10, 1));
  return day > dstStart && day <= dstEnd ? "-04:00" : "-05:00";
}

export const dt = (date: string) => `${date}T00:00:00${easternOffset(date)}`;

// CSM attribution (Natalia, 2026-10-02). One rule per account, in two
// flavours while assignments migrate:
//   - "final" (target model): the Vitally Assigned CSM if they're on the
//     DEDICATED team; otherwise the Vitally Temporary CSM if they're on the
//     POOLED team (a pooled CSM working the account); otherwise the pool.
//   - "interim" (today, mid-migration): the dedicated team's books still live
//     in Temporary CSM and the pooled CSMs' in Assigned CSM, so the fields
//     swap — Temporary if dedicated, else Assigned if pooled, else the pool.
// "The pool" = the pooled team as a whole (no individual CSM), which also
// absorbs accounts whose field holds someone not on a team (leadership,
// former staff…); those are listed separately as cleanup.
// Churn counts for the account's current CSM (Previous_CSM__c not used).
// SOQL can't COALESCE inside GROUP BY, so each query groups by both lookups
// and attributedCsm() picks the owner per row.
export type Attribution = "interim" | "final";

// Which rule fits a period when the viewer hasn't picked one (Natalia,
// 2026-10-02): Q3 2026 and earlier are paid on the dedicated CSMs' Assigned
// CSM books ("final" rule). From Q4 the new dedicated books live in Temporary
// CSM until owners move to Assigned after the Q3 bonus is calculated
// ("interim"). Once that move happens, default everything to "final".
export const INTERIM_STARTS = "2026-10-01";
export const defaultAttribution = (windowStart: string): Attribution =>
  windowStart < INTERIM_STARTS ? "final" : "interim";

const CSM_GROUP = (path: string) =>
  [
    `${path}Vitally_Assigned_CSM__c`,
    `${path}Vitally_Assigned_CSM__r.Name`,
    `${path}Vitally_Temporary_CSM__c`,
    `${path}Vitally_Temporary_CSM__r.Name`,
  ].join(", ");
const CSM_SELECT = (path: string) => `
  ${path}Vitally_Assigned_CSM__c csmId, ${path}Vitally_Assigned_CSM__r.Name csmName,
  ${path}Vitally_Temporary_CSM__c tmpId, ${path}Vitally_Temporary_CSM__r.Name tmpName`;

interface CsmAttributedRow {
  csmId?: string | null;
  csmName?: string | null;
  tmpId?: string | null;
  tmpName?: string | null;
}

export function attributedCsm(row: CsmAttributedRow, by: Attribution): { id: string; name: string } {
  const assigned = { id: row.csmId, name: row.csmName };
  const temporary = { id: row.tmpId, name: row.tmpName };
  const [dedicatedField, pooledField] = by === "final" ? [assigned, temporary] : [temporary, assigned];
  if (dedicatedField.id && dedicatedField.name && teamOf(dedicatedField.name) === "dedicated")
    return { id: dedicatedField.id, name: dedicatedField.name };
  if (pooledField.id && pooledField.name && teamOf(pooledField.name) === "pooled")
    return { id: pooledField.id, name: pooledField.name };
  return { id: "pool", name: POOL };
}

// Active accounts whose Assigned/Temporary CSM is someone not on either team.
// They count for the pool, but the assignment itself needs cleaning up.
export interface CleanupRow {
  name: string;
  assigned: number;
  temporary: number;
}

function cleanupFromBook(book: (CsmAttributedRow & { accounts: number | null })[]): CleanupRow[] {
  const out = new Map<string, CleanupRow>();
  const add = (name: string | null | undefined, field: "assigned" | "temporary", n: number) => {
    if (!name || teamOf(name)) return;
    const row = out.get(name) ?? { name, assigned: 0, temporary: 0 };
    row[field] += n;
    out.set(name, row);
  };
  for (const r of book) {
    add(r.csmName, "assigned", r.accounts ?? 0);
    add(r.tmpName, "temporary", r.accounts ?? 0);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Collapses grouped-aggregate rows onto their attributed CSM, summing the
// given numeric fields. Averages must be rebuilt from summed totals/counts
// afterwards (never average the per-group averages).
export function rollupByCsm<K extends string>(
  rows: (CsmAttributedRow & Record<K, number | null>)[],
  fields: K[],
  by: Attribution
): Map<string, { name: string } & Record<K, number>> {
  const out = new Map<string, { name: string } & Record<K, number>>();
  for (const row of rows) {
    const { id, name } = attributedCsm(row, by);
    const acc = out.get(id) ?? ({ name, ...Object.fromEntries(fields.map((f) => [f, 0])) } as { name: string } & Record<K, number>);
    for (const f of fields) (acc as Record<K, number>)[f] += row[f] ?? 0;
    out.set(id, acc);
  }
  return out;
}

// 1. Logo churn per CSM — accounts whose Stripe subscription was canceled in
// the window, grouped by the CSM who owned them. "Locked as of Oct 1" =
// Stripe_Subscription_Canceled_At__c populated (per Alfredo/Santi, 2026-09-28).
// Same two exclusions the CX capacity planner's churn model uses, which
// brought it within 1-2% of finance's gross churn:
//   - never billed: a lapsed trial carries a cancel date but never paid, so no
//     customer was lost (Stripe_Subscription_First_Invoice_At__c is null).
//   - came back: Canceled_At stays set from the old subscription when an
//     account resubscribes, so an account that is active or trialing today
//     is not churn. past_due / unpaid / incomplete* still count — those have
//     not resubscribed, the status just lags the cancel date.
const CHURN_WHERE = (windowStart: string, windowEnd: string) => `
  WHERE Stripe_Subscription_Canceled_At__c >= ${dt(windowStart)}
    AND Stripe_Subscription_Canceled_At__c < ${dt(windowEnd)}
    AND Stripe_Subscription_First_Invoice_At__c != null
    AND Stripe_Subscription_Status__c NOT IN ('active', 'trialing')
    AND Test_Account__c = false`;

const LOGO_CHURN_SOQL = (windowStart: string, windowEnd: string) => `
  SELECT ${CSM_SELECT("")}, COUNT(Id) churned
  FROM Account ${CHURN_WHERE(windowStart, windowEnd)}
  GROUP BY ${CSM_GROUP("")}
`;

// ARR lost to churn, as last synced from Stripe for the canceled accounts.
// Separate query so a field the integration user can't read never takes the
// account count down with it. Fields in order of preference: total ARR (core
// + AI) after coupons, then core ARR after coupons, then core list ARR. The
// integration user couldn't read the combined field as of 2026-10-02.
const CHURN_ARR_FIELDS = [
  "Combined_Stripe_Subscription_ARR_AC__c",
  "Stripe_Subscription_ARR_After_Coupons__c",
  "Stripe_Subscription_ARR__c",
];
const CHURN_ARR_SOQL = (field: string, windowStart: string, windowEnd: string) => `
  SELECT ${CSM_SELECT("")}, SUM(${field}) arr
  FROM Account ${CHURN_WHERE(windowStart, windowEnd)}
  GROUP BY ${CSM_GROUP("")}
`;

// First ARR field the integration user can read, with its per-row sums; null
// if none can be read (the tiles then say "ARR unavailable").
async function churnArrRows(windowStart: string, windowEnd: string) {
  for (const field of CHURN_ARR_FIELDS) {
    try {
      return { field, rows: await rows<"arr">(CHURN_ARR_SOQL(field, windowStart, windowEnd)) };
    } catch (err) {
      if (!String(err).includes("INVALID_FIELD")) throw err;
    }
  }
  return null;
}

// 2. Net monthly<->annual conversions — MRR_Change__c rows where the billing
// interval flipped between month and year.
const NET_CONVERSIONS_SOQL = (windowStart: string, windowEnd: string) => `
  SELECT ${CSM_SELECT("Account__r.")},
         Starting_Price_Interval__c, Ending_Price_Interval__c,
         COUNT(Id) changes
  FROM MRR_Change__c
  WHERE CreatedDate >= ${dt(windowStart)} AND CreatedDate < ${dt(windowEnd)}
    AND ((Starting_Price_Interval__c = 'month' AND Ending_Price_Interval__c = 'year')
      OR (Starting_Price_Interval__c = 'year' AND Ending_Price_Interval__c = 'month'))
  GROUP BY ${CSM_GROUP("Account__r.")}, Starting_Price_Interval__c, Ending_Price_Interval__c
`;

// 3. QBR coverage — % of each CSM's active book that had at least one
// CX_Event__c categorized "Account Review" ("Business Review with DoorLoop",
// confirmed 2026-09-28) completed in the period.
// Book = accounts currently attributed to the CSM (same assigned → temporary
// rule) with Account_Status__c = 'Active Customer' (formula: Stripe status
// active/past_due and not canceled). It's a snapshot of TODAY's book — SF
// keeps no assignment history — so a past window is measured against the
// current book. The QBR side is limited to the same active book so the ratio
// can't exceed 100%, and counts distinct accounts (two QBRs with one account
// still cover one account).
const ACTIVE_BOOK = (path: string) => `${path}Account_Status__c = 'Active Customer' AND ${path}Test_Account__c = false`;

const BOOK_SIZE_SOQL = `
  SELECT ${CSM_SELECT("")}, COUNT(Id) accounts
  FROM Account
  WHERE ${ACTIVE_BOOK("")}
  GROUP BY ${CSM_GROUP("")}
`;

const QBR_COVERAGE_SOQL = (windowStart: string, windowEnd: string) => `
  SELECT ${CSM_SELECT("Account__r.")}, COUNT_DISTINCT(Account__c) covered
  FROM CX_Event__c
  WHERE Event_Category__c = 'Account Review'
    AND Completed_At__c >= ${dt(windowStart)} AND Completed_At__c < ${dt(windowEnd)}
    AND ${ACTIVE_BOOK("Account__r.")}
  GROUP BY ${CSM_GROUP("Account__r.")}
`;

// Coverage per CSM from book sizes and covered-account counts. CSMs with no
// active book are dropped (nothing to cover).
export function qbrCoverageRows(
  book: Map<string, { name: string; accounts: number }>,
  covered: Map<string, { name: string; covered: number }>,
  target: number
): CsmMetric[] {
  return [...book].flatMap(([id, { name, accounts }]) => {
    if (accounts === 0) return [];
    const n = covered.get(id)?.covered ?? 0;
    const pct = Math.round((n / accounts) * 100);
    return [{ csm: name, value: pct, target, detail: `${n} of ${accounts} accounts`, parts: { num: n, den: accounts }, status: statusFor(pct, target) }];
  });
}

// 4. NPS — NPS_Score__c is a child of Contact (Master-Detail Contact__c), so
// join Contact -> Account to reach the CSM. NPS_Score__c.User__c is the
// follow-up caller ("Who called?"), not the CSM — never group by it.
// NPS is %promoters (9-10) minus %detractors (0-6), not an average of
// Score__c. Score__c is Number(2,0) and SOQL can't GROUP BY a number field,
// so run the same grouped COUNT three times (all / promoters / detractors)
// and combine with npsFromCounts().
// Date__c is the date the survey was SENT. Onboarding NPS lives separately on
// Onboarding__c.Onboarding_NPS_Score__c and is not included here.
// Note: population is still partly manual pending GTM-2512 (Intercom -> SF
// automation); treat coverage as incomplete until that ships.
const NPS_SOQL = (windowStart: string, windowEnd: string, scoreFilter: string) => `
  SELECT ${CSM_SELECT("Contact__r.Account.")}, COUNT(Id) responses
  FROM NPS_Score__c
  WHERE Date__c >= ${windowStart} AND Date__c < ${windowEnd}
    AND ${scoreFilter}
  GROUP BY ${CSM_GROUP("Contact__r.Account.")}
`;

export function npsFromCounts(total: number, promoters: number, detractors: number): number | null {
  return total === 0 ? null : Math.round(((promoters - detractors) / total) * 100);
}

// 5. Save rate — DoorLoop_Cancelation_Request__c: Status__c = 'Saved' over
// all assigned requests in the period. Grouped by the request's Assigned_To__c
// (whoever worked the cancellation), not the account CSM rule above.
const SAVE_RATE_SOQL = (windowStart: string, windowEnd: string) => `
  SELECT Assigned_To__r.Name agent, Status__c, COUNT(Id) requests
  FROM DoorLoop_Cancelation_Request__c
  WHERE Requested_On__c >= ${windowStart} AND Requested_On__c < ${windowEnd}
    AND Assigned_To__c != null
  GROUP BY Assigned_To__r.Name, Status__c
`;

// 6. CSAT — CX_Event__c.Survey_Rating__c (1-5 scale), MUST filter by
// Survey_Id__c so the average never mixes rating scales from other survey
// types stamped on the same field. The CSAT survey id is "CX-CSAT" (the only
// Survey_Id__c in prod as of 2026-10-01, with a single response); override
// with CSAT_SURVEY_ID if the survey is re-keyed.
const CSAT_SOQL = (surveyId: string, windowStart: string, windowEnd: string) => `
  SELECT ${CSM_SELECT("Account__r.")}, SUM(Survey_Rating__c) rating_total, COUNT(Survey_Rating__c) responses
  FROM CX_Event__c
  WHERE Survey_Id__c = '${surveyId}'
    AND Survey_Submitted_At__c >= ${dt(windowStart)} AND Survey_Submitted_At__c < ${dt(windowEnd)}
  GROUP BY ${CSM_GROUP("Account__r.")}
`;

// --- Unresolved (GTM-2515) ------------------------------------------------
// Meaningful connections / Zoom minutes has no confirmed source yet.
// Two candidates, neither confirmed as of 2026-09-28:
//   - CX_Event__c.Meeting_Actual_Duration__c (actual Zoom video-meeting
//     duration per logged customer event)
//   - ZVC__Zoom_Call_Log__c.Call_Duration_Minutes__c (Zoom PHONE call logs,
//     tied to Tasks via ZoomTaskAssociationBatch — likely the wrong object,
//     since "meaningful connections" is about video meetings)
// Do not wire either into production metrics until GTM-2515 closes.

export const MEANINGFUL_CONNECTIONS_GAP = {
  note: "Metric definition and Salesforce source unresolved — see GTM-2515.",
  candidates: [
    "CX_Event__c.Meeting_Actual_Duration__c",
    "ZVC__Zoom_Call_Log__c.Call_Duration_Minutes__c (Zoom Phone — likely wrong object)",
  ],
};

// --- Targets --------------------------------------------------------------
// Comp-plan targets aren't in Salesforce. These defaults are PLACEHOLDERS until
// the real per-CSM values are finalized with Samuel; override them without a
// rebuild by setting BONUS_TARGETS to JSON, e.g.
//   {"logoChurn":2,"netConversions":10,"qbrCoverage":80,"nps":50,"saveRate":60,"csat":4.5}
const DEFAULT_TARGETS = {
  logoChurn: 2,
  netConversions: 10,
  qbrCoverage: 80,
  nps: 50,
  saveRate: 60,
  csat: 4.5,
};
export type Targets = typeof DEFAULT_TARGETS;

function targets(): Targets {
  const raw = process.env.BONUS_TARGETS;
  if (!raw) return DEFAULT_TARGETS;
  try {
    return { ...DEFAULT_TARGETS, ...(JSON.parse(raw) as Partial<Targets>) };
  } catch {
    return DEFAULT_TARGETS;
  }
}

// --- Mock data (default until the read-only integration user exists) ----

function mockMetrics(windowStart: string, windowEnd: string, by: Attribution): BonusMetrics {
  const t = targets();
  // Real roster names so the dedicated/pooled split renders. In the final
  // view pooled CSMs only hold accounts they're actively working.
  const csms =
    by === "interim"
      ? ["Anna Grouzdev", "Austin Leyba", "Sahil Saini", "Tiffany Figueroa", "Guillermo Celta", "Jeremy Galvez", "Nestor Ramirez", POOL]
      : ["Anna Grouzdev", "Austin Leyba", "Sahil Saini", "Tiffany Figueroa", "Guillermo Celta", POOL];
  const mk = (target: number, spread: number): MetricSection => ({
    rows: csms.map((csm, i) => {
      const value = Math.round(target * (0.7 + spread * i));
      return { csm, value, target, status: statusFor(value, target) };
    }),
  });

  const churn = mk(2, 0.15);
  return {
    logoChurn: {
      rows: churn.rows.map((m) => ({ ...m, arr: m.value * 2_340, status: statusForLowerIsBetter(m.value, m.target!) })),
    },
    netConversions: {
      rows: mk(10, 0.12).rows.map((m) => ({ ...m, breakdown: { up: m.value + 3, down: 3 } })),
    },
    qbrCoverage: {
      rows: csms.map((csm, i) => {
        const accounts = 40 + i * 6;
        const n = Math.round(accounts * Math.min(0.95, 0.55 + 0.08 * i));
        const value = Math.round((n / accounts) * 100);
        return { csm, value, target: 80, detail: `${n} of ${accounts} accounts`, parts: { num: n, den: accounts }, status: statusFor(value, 80) };
      }),
    },
    nps: mk(50, 0.05),
    meaningfulConnections: MEANINGFUL_CONNECTIONS_GAP,
    saveRate: {
      rows: csms.map((csm, i) => {
        const total = 10 + i * 3;
        const saved = Math.round(total * (0.45 + 0.08 * i));
        const value = Math.round((saved / total) * 100);
        return { csm, value, target: 60, detail: `${saved} of ${total} saved`, parts: { num: saved, den: total }, status: statusFor(value, 60) };
      }),
    },
    csat: mk(4.5, 0.03),
    windowStart,
    windowEnd,
    attribution: by,
    targets: t,
    churnArrField: "Combined_Stripe_Subscription_ARR_AC__c",
    cleanup: [
      { name: "Miah Camacho", assigned: 12, temporary: 0 },
      { name: "Jeremy Keillor", assigned: 1, temporary: 0 },
    ],
    generatedAt: new Date().toISOString(),
    source: "mock",
  };
}

// --- Live fetch -------------------------------------------------------------

type Row<K extends string> = CsmAttributedRow & Record<K, number | null>;

// The pool and "Unassigned" sort last; everyone else alphabetically.
const LAST = new Set([POOL, "Unassigned"]);
function sortRows(rows: CsmMetric[]): CsmMetric[] {
  return rows.sort((a, b) =>
    LAST.has(a.csm) !== LAST.has(b.csm) ? (LAST.has(a.csm) ? 1 : -1) : a.csm.localeCompare(b.csm)
  );
}

async function section(build: () => Promise<CsmMetric[]>): Promise<MetricSection> {
  try {
    return { rows: sortRows(await build()) };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function rows<K extends string>(soql: string): Promise<Row<K>[]> {
  return (await soqlQuery<Row<K>>(soql)).records;
}

export async function getBonusMetrics(
  windowStart: string,
  windowEnd: string,
  by: Attribution = "interim"
): Promise<BonusMetrics> {
  if (usingMockData()) return mockMetrics(windowStart, windowEnd, by);
  const t = targets();

  let churnArrField: string | null = null;
  const logoChurn = section(async () => {
    const [counts, arr] = await Promise.all([
      rows<"churned">(LOGO_CHURN_SOQL(windowStart, windowEnd)),
      churnArrRows(windowStart, windowEnd).catch(() => null),
    ]);
    churnArrField = arr?.field ?? null;
    const arrByCsm = arr ? rollupByCsm(arr.rows, ["arr"], by) : null;
    const byCsm = rollupByCsm(counts, ["churned"], by);
    return [...byCsm].map(([id, { name, churned }]) => ({
      csm: name,
      value: churned,
      ...(arrByCsm ? { arr: arrByCsm.get(id)?.arr ?? 0 } : {}),
      target: t.logoChurn,
      status: statusForLowerIsBetter(churned, t.logoChurn),
    }));
  });

  // Net = monthly->annual minus annual->monthly, per attributed CSM.
  const netConversions = section(async () => {
    const signed = (await rows<"changes">(NET_CONVERSIONS_SOQL(windowStart, windowEnd))).map((r) => {
      const toAnnual = (r as Record<string, unknown>).Ending_Price_Interval__c === "year";
      const n = r.changes ?? 0;
      return { ...r, net: toAnnual ? n : -n, up: toAnnual ? n : 0, down: toAnnual ? 0 : n };
    });
    const byCsm = rollupByCsm(signed, ["net", "up", "down"], by);
    return [...byCsm.values()].map(({ name, net, up, down }) => ({
      csm: name,
      value: net,
      breakdown: { up, down },
      target: t.netConversions,
      status: statusFor(net, t.netConversions),
    }));
  });

  const bookRows = rows<"accounts">(BOOK_SIZE_SOQL);
  const cleanup = bookRows.then(cleanupFromBook).catch(() => [] as CleanupRow[]);
  const qbrCoverage = section(async () => {
    const [book, covered] = await Promise.all([
      bookRows,
      rows<"covered">(QBR_COVERAGE_SOQL(windowStart, windowEnd)),
    ]);
    return qbrCoverageRows(rollupByCsm(book, ["accounts"], by), rollupByCsm(covered, ["covered"], by), t.qbrCoverage);
  });

  const nps = section(async () => {
    const [all, promoters, detractors] = await Promise.all([
      rows<"responses">(NPS_SOQL(windowStart, windowEnd, "Score__c != null")),
      rows<"responses">(NPS_SOQL(windowStart, windowEnd, "Score__c >= 9")),
      rows<"responses">(NPS_SOQL(windowStart, windowEnd, "Score__c <= 6")),
    ]);
    const tag = (rs: Row<"responses">[], k: "total" | "pro" | "det") => rs.map((r) => ({ ...r, total: 0, pro: 0, det: 0, [k]: r.responses ?? 0 }));
    const byCsm = rollupByCsm([...tag(all, "total"), ...tag(promoters, "pro"), ...tag(detractors, "det")], ["total", "pro", "det"], by);
    return [...byCsm.values()].flatMap(({ name, total, pro, det }) => {
      const score = npsFromCounts(total, pro, det);
      return score === null ? [] : [{ csm: name, value: score, target: t.nps, status: statusFor(score, t.nps) }];
    });
  });

  // Save rate = Saved / all assigned requests, per Assigned_To__c (not the CSM rule).
  const saveRate = section(async () => {
    const byAgent = new Map<string, { saved: number; total: number }>();
    for (const r of (await soqlQuery<Record<string, unknown>>(SAVE_RATE_SOQL(windowStart, windowEnd))).records) {
      const agent = String(r.agent ?? "Unassigned");
      const acc = byAgent.get(agent) ?? { saved: 0, total: 0 };
      const n = Number(r.requests ?? 0);
      acc.total += n;
      if (r.Status__c === "Saved") acc.saved += n;
      byAgent.set(agent, acc);
    }
    return [...byAgent].map(([csm, { saved, total }]) => {
      const pct = total === 0 ? 0 : Math.round((saved / total) * 100);
      return {
        csm,
        value: pct,
        target: t.saveRate,
        detail: `${saved} of ${total} saved`,
        parts: { num: saved, den: total },
        status: statusFor(pct, t.saveRate),
      };
    });
  });

  // CSAT average is rebuilt from summed totals / counts, never averaged averages.
  const csat = section(async () => {
    const surveyId = process.env.CSAT_SURVEY_ID ?? "CX-CSAT";
    const byCsm = rollupByCsm(await rows<"rating_total" | "responses">(CSAT_SOQL(surveyId, windowStart, windowEnd)), ["rating_total", "responses"], by);
    return [...byCsm.values()]
      .filter(({ responses }) => responses > 0)
      .map(({ name, rating_total, responses }) => {
        const avg = Math.round((rating_total / responses) * 10) / 10;
        return { csm: name, value: avg, target: t.csat, status: statusFor(avg, t.csat) };
      });
  });

  return {
    logoChurn: await logoChurn,
    netConversions: await netConversions,
    qbrCoverage: await qbrCoverage,
    nps: await nps,
    meaningfulConnections: MEANINGFUL_CONNECTIONS_GAP,
    saveRate: await saveRate,
    csat: await csat,
    windowStart,
    windowEnd,
    attribution: by,
    targets: t,
    cleanup: await cleanup,
    churnArrField,
    generatedAt: new Date().toISOString(),
    source: "salesforce",
  };
}
