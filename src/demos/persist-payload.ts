import type { ParsedDemo } from "./demo-parser.service";

// The fields of a parse that persist_parsed_demo and persist_imported_demo
// read. Everything else exists only for the playback blob — positions and
// grenade trajectories above all, ~95% of a parse by size — and sending it
// would have Postgres parse tens of MB of jsonb it never looks at.
// persist-payload.spec.ts holds this list to the SQL, so a function that starts
// reading a new field fails the build rather than silently getting nothing.
export const PERSISTED_DEMO_FIELDS = [
  "aim_engagements",
  "bombs",
  "cs2_build",
  "damages",
  "flashes",
  "geometry_validated",
  "grenade_detonations",
  "grenade_throws",
  "kills",
  "map_name",
  "player_trades",
  "players",
  "round_inventory",
  "round_ticks",
  "shots_fired",
  "spotted",
  "tick_rate",
  "total_ticks",
  "workshop_id",
] as const satisfies ReadonlyArray<keyof ParsedDemo>;

// The jsonb argument for persist_parsed_demo / persist_imported_demo.
export function persistPayload(parsed: ParsedDemo): string {
  const payload: Partial<ParsedDemo> = {};
  for (const field of PERSISTED_DEMO_FIELDS) {
    if (parsed[field] !== undefined) {
      (payload as Record<string, unknown>)[field] = parsed[field];
    }
  }
  return JSON.stringify(payload);
}
