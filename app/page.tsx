import {
  defaultAttribution,
  getBonusMetrics,
  statusFor,
  statusForLowerIsBetter,
  type Attribution,
  type BonusMetrics,
  type CsmMetric,
  type MetricSection,
  type Targets,
} from "@/lib/metrics";
import { notCountedReason, POOL, rosterNames, teamOf, TEAMS, type Team } from "@/lib/teams";
import {
  addDays,
  monthWindow,
  quarterWindow,
  resolveWindow,
  yearToDateWindow,
  type ReportWindow,
} from "@/lib/window";

const fmt = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

function presets(): { label: string; window: ReportWindow }[] {
  return [
    { label: "This quarter", window: quarterWindow(0) },
    { label: "Last quarter", window: quarterWindow(-1) },
    { label: "This month", window: monthWindow(0) },
    { label: "Last month", window: monthWindow(-1) },
    { label: "Year to date", window: yearToDateWindow() },
  ];
}

const VIEWS: { id: Attribution; label: string; note: string }[] = [
  {
    id: "final",
    label: "Dedicated by Assigned CSM (Q3 & final)",
    note: "Dedicated CSMs by their Assigned CSM accounts, pooled CSMs by the accounts they're working as Temporary CSM. Everything else counts for the pool. Used for Q3 and earlier, and for everything once owners move to Assigned CSM.",
  },
  {
    id: "interim",
    label: "Dedicated by Temporary CSM (Q4 interim)",
    note: "Dedicated CSMs by their new Temporary CSM books, pooled CSMs by their Assigned CSM accounts. Everything else counts for the pool. Used from Q4 until owners move to Assigned CSM.",
  },
];

// `by` is only carried when the viewer picked a rule; otherwise each period
// gets its default rule (see defaultAttribution).
const href = (from: string, through: string, by: Attribution | null) =>
  `?from=${from}&through=${through}${by ? `&by=${by}` : ""}`;

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: n >= 10_000 ? 1 : 0 });

const STATUS_LABEL: Record<CsmMetric["status"], string> = {
  good: "On track",
  warning: "Watch",
  serious: "Behind",
  critical: "At risk",
};

// Thousands separators, so minute totals read as 15,600 rather than 15600.
const num = (v: number, decimals = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

function Info({ text }: { text: string }) {
  return (
    <span className="info" title={text} aria-label={text} role="img">
      i
    </span>
  );
}

// --- Team split ---------------------------------------------------------------

// Rows for one team. Count metrics (churn, net conversions) list every roster
// member, with 0 for anyone who had no records — a CSM with zero churn should
// read "0, on track", not disappear. Ratio metrics with no records stay
// missing (there's nothing to divide).
function forTeam(
  s: MetricSection,
  team: Team,
  zeroFill?: { target: number; lowerIsBetter?: boolean; arr?: boolean; breakdown?: boolean }
): MetricSection {
  const rows = s.rows.filter((r) => teamOf(r.csm) === team);
  if (zeroFill && !s.error) {
    const present = new Set(rows.map((r) => r.csm.toLowerCase()));
    for (const csm of members(team)) {
      if (present.has(csm.toLowerCase())) continue;
      const status = zeroFill.lowerIsBetter ? statusForLowerIsBetter(0, zeroFill.target) : statusFor(0, zeroFill.target);
      rows.push({ csm, value: 0, target: zeroFill.target, status, ...(zeroFill.arr ? { arr: 0 } : {}), ...(zeroFill.breakdown ? { breakdown: { up: 0, down: 0 } } : {}) });
    }
    rows.sort((a, b) => a.csm.localeCompare(b.csm));
  }
  return { error: s.error, rows };
}

// Roster plus, for the pooled team, the pool row (accounts with no team CSM).
const members = (team: Team) => (team === "pooled" ? [...rosterNames(team), POOL] : rosterNames(team));

// --- Scorecard (one row per CSM, one column per KPI) -------------------------

const SCORECARD: {
  key: "logoChurn" | "netConversions" | "qbrCoverage" | "nps" | "saveRate" | "csat" | "zoomMinutes";
  label: string;
  unit?: string;
  decimals?: number;
  targetPrefix?: string;
  // Header text when the target isn't one number from `targets`.
  targetText?: (t: Targets) => string;
}[] = [
  { key: "logoChurn", label: "Logo churn", targetPrefix: "max " },
  { key: "netConversions", label: "Net monthly → annual" },
  { key: "qbrCoverage", label: "QBR coverage", unit: "%" },
  { key: "nps", label: "NPS" },
  { key: "saveRate", label: "Save rate", unit: "%" },
  { key: "csat", label: "CSAT", decimals: 1 },
  { key: "zoomMinutes", label: "Zoom minutes", targetText: (t) => `target ${t.zoomMinutesPerDay}/working day` },
];

function Scorecard({ team, m }: { team: Team; m: BonusMetrics }) {
  return (
    <section className="panel">
      <h3>
        Scorecard <Info text="Each CSM's value for every KPI in the period, against its target. — means no records to measure (e.g. no surveys or cancellation requests)." />
      </h3>
      <div className="table-wrap">
        <table className="table scorecard">
          <thead>
            <tr>
              <th>CSM</th>
              {SCORECARD.map((c) => (
                <th key={c.key} className="num">
                  {c.label}
                  <span className="th-target">
                    {c.targetText
                      ? c.targetText(m.targets)
                      : `target ${c.targetPrefix ?? ""}${m.targets[c.key as keyof Targets].toFixed(c.decimals ?? 0)}${c.unit ?? ""}`}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members(team).map((csm) => (
              <tr key={csm}>
                <td>{csm}</td>
                {SCORECARD.map((c) => {
                  const section = m[c.key];
                  if (section.error)
                    return (
                      <td key={c.key} className="num muted" title={section.error}>
                        error
                      </td>
                    );
                  const row = section.rows.find((r) => r.csm.toLowerCase() === csm.toLowerCase());
                  if (!row)
                    return (
                      <td key={c.key} className="num muted">
                        —
                      </td>
                    );
                  return (
                    <td key={c.key} className="num">
                      <span className={`score status-${row.status}`} title={`${STATUS_LABEL[row.status]}${row.detail ? ` · ${row.detail}` : ""}`}>
                        <span className="status-dot" aria-hidden="true" />
                        {num(row.value, c.decimals)}
                        {c.unit ?? ""}
                      </span>
                      {row.detail && <span className="cell-detail">{row.detail}</span>}
                      {row.arr !== undefined && <span className="cell-detail">{usd(row.arr)} ARR</span>}
                      {row.breakdown && (
                        <span className="cell-detail">
                          ↑{row.breakdown.up} / ↓{row.breakdown.down}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Team summary (big coloured cards) ------------------------------------------

interface Summary {
  label: string;
  value: string;
  sub: string;
  tone: "navy" | "blue" | "neon" | "ink";
}

const unavailable = (s: MetricSection) => !!s.error || s.rows.length === 0;
const sum = (s: MetricSection) => s.rows.reduce((acc, r) => acc + r.value, 0);

// Ratio metrics are pooled from their parts, never averaged across CSMs.
function pooled(s: MetricSection, noun: string): { value: string; sub: string } {
  const num = s.rows.reduce((acc, r) => acc + (r.parts?.num ?? 0), 0);
  const den = s.rows.reduce((acc, r) => acc + (r.parts?.den ?? 0), 0);
  if (den === 0) return { value: "—", sub: "no data in this period" };
  return { value: `${Math.round((num / den) * 100)}%`, sub: `${num.toLocaleString()} of ${den.toLocaleString()} ${noun}` };
}

function teamSummary(m: BonusMetrics): Summary[] {
  const net = sum(m.netConversions);
  return [
    {
      label: "Logo churn",
      value: unavailable(m.logoChurn) ? "—" : sum(m.logoChurn).toLocaleString(),
      sub: unavailable(m.logoChurn)
        ? "accounts canceled (lower is better)"
        : m.churnArrField
          ? `accounts canceled · ${usd(m.logoChurn.rows.reduce((acc, r) => acc + (r.arr ?? 0), 0))} ARR lost`
          : "accounts canceled · ARR unavailable",
      tone: "navy",
    },
    {
      label: "Net monthly → annual",
      value: unavailable(m.netConversions) ? "—" : `${net > 0 ? "+" : ""}${net.toLocaleString()}`,
      sub: m.netConversions.error
        ? "couldn't load"
        : `↑${m.netConversions.rows.reduce((a, r) => a + (r.breakdown?.up ?? 0), 0)} to annual / ↓${m.netConversions.rows.reduce((a, r) => a + (r.breakdown?.down ?? 0), 0)} to monthly`,
      tone: "blue",
    },
    { label: "QBR coverage", ...pooled(m.qbrCoverage, "active accounts"), tone: "neon" },
    { label: "Save rate", ...pooled(m.saveRate, "requests saved"), tone: "ink" },
    { label: "Zoom minutes", ...zoomTotal(m.zoomMinutes), tone: "blue" },
  ];
}

// Team minutes against the team's combined target (each CSM's target summed).
function zoomTotal(s: MetricSection): { value: string; sub: string } {
  if (s.error) return { value: "—", sub: "couldn't load" };
  if (s.rows.length === 0) return { value: "—", sub: "no data in this period" };
  const target = s.rows.reduce((acc, r) => acc + (r.target ?? 0), 0);
  return { value: num(sum(s)), sub: `phone + meetings · target ${num(target)}` };
}

function SummaryCard({ s }: { s: Summary }) {
  return (
    <div className={`kpi kpi-${s.tone}`}>
      <span className="kpi-label">{s.label}</span>
      <span className="kpi-value">{s.value}</span>
      <span className="kpi-sub">{s.sub}</span>
    </div>
  );
}

// --- Per-CSM panels ---------------------------------------------------------

function Tile({ metric, unit = "", decimals = 0 }: { metric: CsmMetric; unit?: string; decimals?: number }) {
  return (
    <div className="tile">
      <span className="tile-csm">{metric.csm}</span>
      <span className="tile-value">
        {num(metric.value, decimals)}
        {unit}
      </span>
      {metric.detail && <span className="tile-meta">{metric.detail}</span>}
      {metric.arr !== undefined && <span className="tile-meta">{usd(metric.arr)} ARR lost</span>}
      {metric.breakdown && (
        <span className="tile-meta">
          ↑{metric.breakdown.up} to annual / ↓{metric.breakdown.down} to monthly
        </span>
      )}
      {metric.target !== undefined && (
        <span className="tile-meta">
          target {num(metric.target, decimals)}
          {unit}
        </span>
      )}
      <span className={`status-badge status-${metric.status}`}>
        <span className="status-dot" aria-hidden="true" />
        {STATUS_LABEL[metric.status]}
      </span>
    </div>
  );
}

function Panel({
  title,
  info,
  section,
  unit,
  decimals,
  emptyNote = "No records for this team in this period.",
}: {
  title: string;
  info: string;
  section: MetricSection;
  unit?: string;
  decimals?: number;
  emptyNote?: string;
}) {
  return (
    <section className="panel">
      <h3>
        {title} <Info text={info} />
      </h3>
      {section.error ? (
        <div className="note">
          <strong>Couldn&apos;t load this metric.</strong> {section.error}
        </div>
      ) : section.rows.length === 0 ? (
        <div className="note">{emptyNote}</div>
      ) : (
        <div className="tile-grid">
          {section.rows.map((m) => (
            <Tile key={m.csm} metric={m} unit={unit} decimals={decimals} />
          ))}
        </div>
      )}
    </section>
  );
}

function TeamBand({ team, label, m, tint }: { team: Team; label: string; m: BonusMetrics; tint: boolean }) {
  return (
    <section className={`band${tint ? " band-tint" : ""}`}>
      <div className="wrap">
        <h2>{label}</h2>
        <p className="band-sub">Team totals for the period, a scorecard of every KPI by CSM, then the detail per KPI.</p>
        <div className="kpi-grid">
          {teamSummary(m).map((s) => (
            <SummaryCard key={s.label} s={s} />
          ))}
        </div>
        <div className="panels">
          <Scorecard team={team} m={m} />
          <Panel
            title="Logo churn"
            info="Accounts whose Stripe subscription was canceled in the period, credited to the account's current CSM under this rule, with their total ARR (core + AI, after coupons). Lower is better."
            section={m.logoChurn}
          />
          <Panel
            title="Net monthly → annual conversions"
            info="Monthly → annual switches minus annual → monthly downgrades, from MRR Change records in the period. New and ended subscriptions don't count."
            section={m.netConversions}
          />
          <Panel
            title="QBR coverage"
            info="Share of the CSM's active book (Account Status = Active Customer) with at least one completed CX Event of category Account Review in the period."
            section={m.qbrCoverage}
            unit="%"
            emptyNote="No active accounts for this team in this view. QBRs count when logged as CX Events with category “Account Review”."
          />
          <Panel
            title="NPS"
            info="% promoters (9–10) minus % detractors (0–6), by survey send date. Coverage is partial until Intercom → Salesforce NPS (GTM-2512) ships."
            section={m.nps}
          />
          <Panel
            title="Save rate"
            info="Cancellation requests marked Saved over all requests assigned to the CSM in the period (by who worked the request, same in both views)."
            section={m.saveRate}
            unit="%"
          />
          <Panel
            title="CSAT"
            info="Average CX Event survey rating (1–5) for survey CX-CSAT, by submission date."
            section={m.csat}
            decimals={1}
            emptyNote="No CSAT responses (survey CX-CSAT) for this team in this period."
          />
          <Panel
            title="Meaningful connections (Zoom minutes)"
            info="Zoom Phone minutes (inbound and outbound) plus Zoom meeting minutes recorded by Gong, credited to the person who made the call or held the meeting. Phone minutes come from the Zoom call log, or from Gong for any week where Gong has more calls. Target: 4 hours per working day in the period. Same rules as the CSM Team Activity dashboard."
            section={m.zoomMinutes}
          />
        </div>
      </div>
    </section>
  );
}

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const picked = one(params.by);
  const explicitBy: Attribution | null = picked === "final" || picked === "interim" ? picked : null;
  const { windowStart, windowEnd } = resolveWindow({
    from: one(params.from),
    to: one(params.to),
    through: one(params.through),
    quarter: one(params.quarter),
  });
  const through = addDays(windowEnd, -1);
  const by = explicitBy ?? defaultAttribution(windowStart);
  const metrics = await getBonusMetrics(windowStart, windowEnd, by);
  const live = metrics.source === "salesforce";
  const activePreset = presets().find(
    ({ window }) => window.windowStart === windowStart && window.windowEnd === windowEnd
  );
  const view = VIEWS.find((v) => v.id === by)!;

  const team = (t: Team): BonusMetrics => ({
    ...metrics,
    logoChurn: forTeam(metrics.logoChurn, t, { target: metrics.targets.logoChurn, lowerIsBetter: true, arr: !!metrics.churnArrField }),
    netConversions: forTeam(metrics.netConversions, t, { target: metrics.targets.netConversions, breakdown: true }),
    qbrCoverage: forTeam(metrics.qbrCoverage, t),
    nps: forTeam(metrics.nps, t),
    saveRate: forTeam(metrics.saveRate, t),
    csat: forTeam(metrics.csat, t),
    zoomMinutes: forTeam(metrics.zoomMinutes, t),
  });

  return (
    <>
      <div className="topbar">
        <strong>CSM Bonus Tracking</strong> · {live ? "live numbers from Salesforce" : "sample numbers until Salesforce is connected"}
      </div>

      <header className="hero">
        <div className="hero-art" aria-hidden="true" />
        <div className="wrap hero-inner">
          <p className="eyebrow">DoorLoop CX · KPIs &amp; Comp</p>
          <h1>CSM Bonus Tracking</h1>
          <p className="lede">
            How the dedicated and pooled teams are tracking against the bonus KPIs: logo churn, monthly → annual
            conversions, QBR coverage, NPS, save rate, CSAT and Zoom minutes. Pick a period and which assignment rule to use.
          </p>

          <nav className="pills" aria-label="Reporting period">
            {presets().map(({ label, window }) => {
              const active = activePreset?.label === label;
              return (
                <a
                  key={label}
                  className={`pill${active ? " pill-active" : ""}`}
                  href={href(window.windowStart, addDays(window.windowEnd, -1), explicitBy)}
                  aria-current={active ? "true" : undefined}
                >
                  {label}
                </a>
              );
            })}
          </nav>

          <details className="range" open={!activePreset}>
            <summary>Pick specific dates</summary>
            <form className="range-form" method="get">
              {explicitBy && <input type="hidden" name="by" value={explicitBy} />}
              <label>
                From
                <input type="date" name="from" defaultValue={windowStart} max={through} required />
              </label>
              <label>
                To
                <input type="date" name="through" defaultValue={through} min={windowStart} required />
              </label>
              <button type="submit" className="btn btn-neon">
                Apply
              </button>
            </form>
          </details>

          <div className="view-switch">
            <span className="view-label">Assignment rule</span>
            <nav className="pills" aria-label="Assignment rule">
              {VIEWS.map((v) => (
                <a
                  key={v.id}
                  className={`pill${v.id === by ? " pill-active" : ""}`}
                  href={href(windowStart, through, v.id)}
                  aria-current={v.id === by ? "true" : undefined}
                >
                  {v.label}
                </a>
              ))}
            </nav>
          </div>

          <p className="hero-meta">
            Source: <strong>{live ? "Salesforce (read-only)" : "Mock data"}</strong>
            {!live && " (Salesforce credentials not set, see .env.example)"}
          </p>
          <p className="hero-meta">
            Updated: <strong>{new Date(metrics.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</strong>
          </p>
        </div>
      </header>

      <main>
        <div className="period-head">
          <div className="wrap">
            <h2>
              {activePreset ? `${activePreset.label}: ` : ""}
              {fmt(windowStart)} – {fmt(through)}
            </h2>
            <p className="band-sub">
              <strong>{view.label}.</strong> {view.note}
              {!explicitBy && " Picked automatically for this period."}
            </p>
          </div>
        </div>

        {TEAMS.map((t, i) => (
          <TeamBand key={t.id} team={t.id} label={t.label} m={team(t.id)} tint={i % 2 === 1} />
        ))}

        <section className="band">
          <div className="wrap">
            <h2>Assignments to clean up</h2>
            <p className="band-sub">
              Active accounts whose Assigned or Temporary CSM is someone outside the dedicated and pooled teams. They
              count for the pool until they&apos;re reassigned in Salesforce.
            </p>
            <section className="panel">
              {metrics.cleanup.length === 0 ? (
                <div className="note">No active accounts are assigned to anyone outside the two teams.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Why</th>
                        <th className="num">As Assigned CSM</th>
                        <th className="num">As Temporary CSM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.cleanup.map((r) => (
                        <tr key={r.name}>
                          <td>{r.name}</td>
                          <td className="muted">{notCountedReason(r.name)}</td>
                          <td className="num">{r.assigned.toLocaleString()}</td>
                          <td className="num">{r.temporary.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap">
          Source: Salesforce, read-only. Team rosters live in lib/teams.ts (Salesforce has no dedicated/pooled
          field). Targets are placeholders until the comp plan is final. Field mapping: GTM-2496 · Dashboard:
          GTM-2495.
        </div>
      </footer>
    </>
  );
}
