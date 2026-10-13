import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { PERSISTED_DEMO_FIELDS, persistPayload } from "./persist-payload";
import type { ParsedDemo } from "./demo-parser.service";

const SQL_DIR = join(__dirname, "../../hasura/functions/demos");

const sqlFiles = () =>
  readdirSync(SQL_DIR)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => ({ file, sql: readFileSync(join(SQL_DIR, file), "utf8") }));

describe("persistPayload", () => {
  // The payload is a whitelist, so a field the SQL reads but the list lacks
  // would arrive as NULL with no error anywhere. Every field the functions take
  // off p_parsed has to be on the list.
  it("carries every field the persist functions read", () => {
    const read = new Set<string>();
    for (const { sql } of sqlFiles()) {
      for (const match of sql.matchAll(/p_parsed\s*->>?\s*'([a-z0-9_]+)'/g)) {
        read.add(match[1]);
      }
    }
    expect(read.size).toBeGreaterThan(0);
    const missing = [...read].filter(
      (field) => !(PERSISTED_DEMO_FIELDS as readonly string[]).includes(field),
    );
    expect(missing).toEqual([]);
  });

  // The test above only sees `p_parsed->'field'`. Any other use of the whole
  // document (a jsonb_each, a #> path, handing it to another function) could
  // read fields it cannot see, so each one has to be accounted for here.
  it("finds no other use of the parsed document", () => {
    const unexplained: string[] = [];
    for (const { file, sql } of sqlFiles()) {
      sql.split("\n").forEach((line, i) => {
        const rest = line
          .replace(/p_parsed\s*->>?\s*'[a-z0-9_]+'/g, "")
          .replace(/^\s*p_parsed\s+jsonb\b/, "")
          .replace(
            /public\.persist_parsed_demo\(p_match_map_demo_id, p_parsed\)/,
            "",
          );
        if (rest.includes("p_parsed")) {
          unexplained.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(unexplained).toEqual([]);
  });

  it("drops what only the playback blob needs", () => {
    const parsed = {
      total_ticks: 100,
      tick_rate: 64,
      map_name: "de_anubis",
      kills: [{ tick: 1 }],
      positions: [{ tick: 1, x: 0, y: 0, z: 0 }],
      grenade_trajectories: [{ gid: 1, pts: [] }],
      smoke_volumes: [],
      smoke_voxels: [],
      infernos: [],
    } as unknown as ParsedDemo;

    expect(JSON.parse(persistPayload(parsed))).toEqual({
      total_ticks: 100,
      tick_rate: 64,
      map_name: "de_anubis",
      kills: [{ tick: 1 }],
    });
  });
});
