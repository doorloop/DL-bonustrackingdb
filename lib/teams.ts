// CS team rosters. Salesforce has no field saying whether a CSM is dedicated
// or pooled, so membership lives here (confirmed with Natalia, 2026-10-02).
// Names must match the Salesforce User Name exactly (case-insensitive).
// Update this file when the team changes.

export type Team = "dedicated" | "pooled";

const ROSTER: Record<Team, string[]> = {
  dedicated: ["Anna Grouzdev", "Austin Leyba", "Sahil Saini", "Tiffany Figueroa"],
  pooled: [
    "Ashlie Aguilar",
    "Danny Rasmussen",
    "Guillermo Celta",
    "Jeremy Galvez",
    "Nestor Ramirez",
  ],
};

// Salesforce User ids for the roster, used where activity is credited to the
// person who did it (Zoom calls and meetings) rather than through an account.
// Copied from the CSM Team Activity dashboard's roster.json
// (gheffner/agent_tracking, csm-activity/), verified live 2026-10-09.
const USER_IDS: Record<string, string> = {
  "Anna Grouzdev": "0054W00000FVcByQAL",
  "Austin Leyba": "005QU00000HB26LYAT",
  "Sahil Saini": "005QU00000Ms6i5YAB",
  "Tiffany Figueroa": "0054W00000FrqyEQAR",
  "Ashlie Aguilar": "005QU00000HB2BBYA1",
  "Danny Rasmussen": "005QU000001VtAwYAK",
  "Guillermo Celta": "005QU00000OSFvxYAH",
  "Jeremy Galvez": "005QU00000WZCaAYAX",
  "Nestor Ramirez": "0054W00000FfKZuQAN",
};

// People who show up in the data but never count toward a team's KPIs.
// Accounts attributed to them are surfaced as a data-cleanup list instead.
const NOT_COUNTED: Record<string, string[]> = {
  Leadership: ["Christopher Real", "Chris Real", "Miah Camacho", "Matt Cave"],
  Onboarding: ["Alvaro Jara", "Sebastian Hidalgo", "Adrian Cintas"],
  "No longer at DoorLoop": ["Jeremy Keillor"],
  "Shouldn't own accounts": ["Nicole Toledano"],
};

const key = (name: string) => name.trim().toLowerCase();
const TEAM_OF = new Map<string, Team>(
  (Object.entries(ROSTER) as [Team, string[]][]).flatMap(([team, names]) => names.map((n) => [key(n), team]))
);
const GROUP_OF = new Map<string, string>(
  Object.entries(NOT_COUNTED).flatMap(([group, names]) => names.map((n) => [key(n), group]))
);

export const TEAMS: { id: Team; label: string }[] = [
  { id: "dedicated", label: "Dedicated team" },
  { id: "pooled", label: "Pooled team" },
];

// Accounts with no team CSM in the field that applies belong to the pooled
// team as a whole. They show up as this one row.
export const POOL = "Pool (no CSM)";

export const teamOf = (name: string): Team | null =>
  name === POOL ? "pooled" : (TEAM_OF.get(key(name)) ?? null);

// Why a name holding accounts isn't on a team: a known group or "Not on a team".
export function notCountedReason(name: string): string {
  return GROUP_OF.get(key(name)) ?? "Not on a team roster";
}

export const rosterNames = (team: Team) => ROSTER[team];

// Every roster member with a known Salesforce User id. A roster name missing
// from USER_IDS is left out of the Zoom minutes until its id is added.
export const rosterUsers = (): { id: string; name: string }[] =>
  Object.values(ROSTER)
    .flat()
    .flatMap((name) => (USER_IDS[name] ? [{ id: USER_IDS[name], name }] : []));
