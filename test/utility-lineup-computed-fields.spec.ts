import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Pins what every utility_lineups computed field returns, so how the fields
// are evaluated can change without any answer changing with it.
describe("utility lineup computed fields", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  let author: string;
  let owner: string;
  let teamAdmin: string;
  let member: string;
  let stranger: string;
  let teamId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityLineupComputedFieldsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199710000000n);

    const team = await fx.team();
    teamId = team.id;
    owner = team.owner;
    author = await fx.player();
    teamAdmin = await fx.player();
    member = await fx.player();
    stranger = await fx.player();

    for (const [steamId, role] of [
      [author, "Member"],
      [teamAdmin, "Admin"],
      [member, "Member"],
    ]) {
      await runAsUser(postgres, owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, role, status) VALUES ($1, $2, $3, 'Starter')",
          [teamId, steamId, role],
        ),
      );
    }
    await postgres.query(
      "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
      [teamId, teamAdmin],
    );

    await postgres.query(
      `INSERT INTO private.file_url_signing_key (key)
       VALUES (decode('00112233445566778899aabbccddeeff', 'hex'))
       ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query(
      "DELETE FROM settings WHERE name IN ('cloudflare_worker_url', 'demos_domain')",
    );
  });

  async function lineup(overrides: Record<string, unknown> = {}) {
    const row = {
      map_name: "de_mirage",
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      name: "Window from T spawn",
      visibility: "Private",
      author_steam_id: author,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  const session = (role: string | null, steamId?: string | null) =>
    JSON.stringify({
      ...(role ? { "x-hasura-role": role } : {}),
      ...(steamId !== undefined ? { "x-hasura-user-id": steamId ?? "" } : {}),
    });

  async function field<T>(
    fn: string,
    lineupId: string,
    hasuraSession?: string,
  ): Promise<T> {
    const [row] = await postgres.query<Array<{ value: T }>>(
      hasuraSession === undefined
        ? `SELECT public.${fn}(l) AS value FROM utility_lineups l WHERE l.id = $1`
        : `SELECT public.${fn}(l, $2::json) AS value FROM utility_lineups l WHERE l.id = $1`,
      hasuraSession === undefined ? [lineupId] : [lineupId, hasuraSession],
    );
    return row.value;
  }

  type Viewer = { name: string; session: string };

  function viewers(): Array<Viewer> {
    return [
      { name: "guest", session: session("guest") },
      { name: "empty session", session: "{}" },
      { name: "blank user id", session: session("user", null) },
      { name: "author", session: session("user", author) },
      { name: "team owner", session: session("user", owner) },
      { name: "team admin", session: session("user", teamAdmin) },
      { name: "team member", session: session("user", member) },
      { name: "stranger", session: session("user", stranger) },
      { name: "moderator", session: session("moderator", stranger) },
      { name: "administrator", session: session("administrator", stranger) },
      { name: "admin", session: session("admin", stranger) },
      { name: "verified user", session: session("verified_user", stranger) },
    ];
  }

  // Columns are viewers in the order viewers() lists them.
  const VIEW: Record<string, Array<boolean | null>> = {
    Public: [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ],
    Private: [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    Team: [
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      false,
    ],
    "Public archived": [
      null,
      null,
      null,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    "Private archived": [
      null,
      null,
      null,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    "Team archived": [
      null,
      null,
      null,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
  };

  const EDIT: Record<string, Array<boolean>> = {
    Public: [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    Private: [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    Team: [
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    "Public archived": [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    "Private archived": [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
    "Team archived": [
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      false,
    ],
  };

  async function lineupsByCase(): Promise<Record<string, string>> {
    const archivedAt = "2026-03-04T05:06:07Z";
    return {
      Public: await lineup({ visibility: "Public" }),
      Private: await lineup({ visibility: "Private" }),
      Team: await lineup({ visibility: "Team", team_id: teamId }),
      "Public archived": await lineup({
        visibility: "Public",
        archived_at: archivedAt,
      }),
      "Private archived": await lineup({
        visibility: "Private",
        archived_at: archivedAt,
      }),
      "Team archived": await lineup({
        visibility: "Team",
        team_id: teamId,
        archived_at: archivedAt,
      }),
    };
  }

  it("can_view answers the same for every visibility and viewer", async () => {
    const ids = await lineupsByCase();
    for (const [name, id] of Object.entries(ids)) {
      const actual: Array<boolean | null> = [];
      for (const viewer of viewers()) {
        actual.push(
          await field<boolean | null>(
            "can_view_utility_lineup",
            id,
            viewer.session,
          ),
        );
      }
      expect({ name, actual }).toEqual({ name, actual: VIEW[name] });
    }
  });

  it("can_edit answers the same for every visibility and viewer", async () => {
    const ids = await lineupsByCase();
    for (const [name, id] of Object.entries(ids)) {
      const actual: Array<boolean | null> = [];
      for (const viewer of viewers()) {
        actual.push(
          await field<boolean | null>(
            "can_edit_utility_lineup",
            id,
            viewer.session,
          ),
        );
      }
      expect({ name, actual }).toEqual({ name, actual: EDIT[name] });
    }
  });

  it("my_vote is the viewer's own vote, or null", async () => {
    const id = await lineup({ visibility: "Public" });
    await postgres.query(
      "INSERT INTO utility_lineup_votes (utility_lineup_id, steam_id, vote) VALUES ($1, $2, 1), ($1, $3, -1)",
      [id, author, stranger],
    );

    expect(
      await field("utility_lineup_my_vote", id, session("user", author)),
    ).toBe(1);
    expect(
      await field("utility_lineup_my_vote", id, session("user", stranger)),
    ).toBe(-1);
    expect(
      await field("utility_lineup_my_vote", id, session("user", member)),
    ).toBeNull();
    expect(
      await field("utility_lineup_my_vote", id, session("guest")),
    ).toBeNull();
    expect(
      await field("utility_lineup_my_vote", id, session("user", null)),
    ).toBeNull();
  });

  it("is_favorited is true only for a viewer who favourited it", async () => {
    const id = await lineup({ visibility: "Public" });
    await postgres.query(
      "INSERT INTO utility_lineup_favorites (utility_lineup_id, steam_id) VALUES ($1, $2)",
      [id, stranger],
    );

    expect(
      await field("utility_lineup_is_favorited", id, session("user", stranger)),
    ).toBe(true);
    expect(
      await field("utility_lineup_is_favorited", id, session("user", author)),
    ).toBe(false);
    expect(
      await field("utility_lineup_is_favorited", id, session("guest")),
    ).toBe(false);
    expect(
      await field("utility_lineup_is_favorited", id, session("user", null)),
    ).toBe(false);
  });

  it("difficulty keeps its floors and rate thresholds", async () => {
    const cases: Array<[number, number, number, string]> = [
      [0, 0, 0, "unmeasured"],
      [2, 100, 100, "unmeasured"],
      [3, 29, 29, "unmeasured"],
      [3, 30, 21, "easy"],
      [3, 30, 20, "moderate"],
      [3, 100, 45, "moderate"],
      [3, 100, 44, "hard"],
      [3, 100, 20, "hard"],
      [3, 100, 19, "very_hard"],
      [3, 100, 0, "very_hard"],
      [50, 1000, 700, "easy"],
    ];
    for (const [players, attempts, successes, expected] of cases) {
      const id = await lineup({
        practice_players: players,
        practice_attempts: attempts,
        practice_successes: successes,
      });
      expect({
        players,
        attempts,
        successes,
        difficulty: await field("utility_lineup_difficulty", id),
      }).toEqual({ players, attempts, successes, difficulty: expected });
    }
  });

  async function signature(key: string, publicFile: boolean) {
    const [row] = await postgres.query<Array<{ sig: string | null }>>(
      "SELECT public.file_url_signature($1, $2) AS sig",
      [key, publicFile],
    );
    return row.sig;
  }

  async function expectedUrl(
    base: string,
    key: string,
    version: string,
    publicFile: boolean,
  ) {
    const sig = await signature(key, publicFile);
    return `${base}/${key}?v=${version}${sig ? `&${sig}` : ""}`;
  }

  const RENDERED_AT = "2026-01-02T03:04:05Z";
  const RENDERED_EPOCH = String(Date.parse(RENDERED_AT) / 1000);
  const VOXELS_AT = "2026-02-03T04:05:06.789Z";
  const VOXELS_EPOCH = String(Math.round(Date.parse(VOXELS_AT) / 1000));

  async function filesLineup(overrides: Record<string, unknown> = {}) {
    return lineup({
      preview_file: "clips/utility/a/preview.mp4",
      preview_thumbnail: "clips/utility/a/thumb.jpg",
      preview_rendered_at: RENDERED_AT,
      preview_stills: {
        aim: "clips/utility/a/aim.jpg",
        land: "clips/utility/a/land.jpg",
      },
      smoke_voxels_file: "clips/utility/a/voxels.bin",
      smoke_voxels_at: VOXELS_AT,
      ...overrides,
    });
  }

  const BASES: Array<[string, Record<string, string>, string | null]> = [
    [
      "worker",
      {
        cloudflare_worker_url: "https://cf.example.test",
        demos_domain: "https://demos.example.test",
      },
      "https://cf.example.test",
    ],
    [
      "demos domain",
      { demos_domain: "https://demos.example.test" },
      "https://demos.example.test",
    ],
    ["no base", {}, null],
  ];

  async function settings(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      await postgres.query(
        "INSERT INTO settings (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value",
        [name, value],
      );
    }
  }

  for (const [label, values, base] of BASES) {
    describe(`file urls with ${label}`, () => {
      beforeEach(async () => {
        await settings(values);
      });

      it("signs a public lineup's files for a year and anything else for hours", async () => {
        const visibilities: Array<[Record<string, unknown>, boolean]> = [
          [{ visibility: "Public" }, true],
          [{ visibility: "Private" }, false],
          [{ visibility: "Team", team_id: teamId }, false],
          [
            { visibility: "Public", archived_at: "2026-03-04T05:06:07Z" },
            false,
          ],
        ];
        for (const [overrides, publicFile] of visibilities) {
          const id = await filesLineup(overrides);
          const urls = {
            preview: await field("utility_lineup_preview_url", id),
            thumbnail: await field("utility_lineup_preview_thumbnail_url", id),
            stills: await field("utility_lineup_preview_stills_url", id),
            voxels: await field("utility_lineup_smoke_voxels_url", id),
          };
          const expected =
            base === null
              ? { preview: null, thumbnail: null, stills: null, voxels: null }
              : {
                  preview: await expectedUrl(
                    base,
                    "clips/utility/a/preview.mp4",
                    RENDERED_EPOCH,
                    publicFile,
                  ),
                  thumbnail: await expectedUrl(
                    base,
                    "clips/utility/a/thumb.jpg",
                    RENDERED_EPOCH,
                    publicFile,
                  ),
                  stills: {
                    aim: await expectedUrl(
                      base,
                      "clips/utility/a/aim.jpg",
                      RENDERED_EPOCH,
                      publicFile,
                    ),
                    land: await expectedUrl(
                      base,
                      "clips/utility/a/land.jpg",
                      RENDERED_EPOCH,
                      publicFile,
                    ),
                  },
                  voxels: await expectedUrl(
                    base,
                    "clips/utility/a/voxels.bin",
                    VOXELS_EPOCH,
                    publicFile,
                  ),
                };
          expect({ overrides, urls }).toEqual({ overrides, urls: expected });
        }
      });

      it("falls back to version 0 without a render or recording time", async () => {
        const id = await filesLineup({
          visibility: "Public",
          preview_rendered_at: null,
          smoke_voxels_at: null,
        });
        expect(await field("utility_lineup_preview_url", id)).toBe(
          base &&
            (await expectedUrl(base, "clips/utility/a/preview.mp4", "0", true)),
        );
        expect(await field("utility_lineup_smoke_voxels_url", id)).toBe(
          base &&
            (await expectedUrl(base, "clips/utility/a/voxels.bin", "0", true)),
        );
      });

      it("returns null for files that do not exist and an empty map for no stills", async () => {
        const none = await lineup({ visibility: "Public" });
        expect(await field("utility_lineup_preview_url", none)).toBeNull();
        expect(
          await field("utility_lineup_preview_thumbnail_url", none),
        ).toBeNull();
        expect(
          await field("utility_lineup_preview_stills_url", none),
        ).toBeNull();
        expect(await field("utility_lineup_smoke_voxels_url", none)).toBeNull();

        const empty = await filesLineup({
          visibility: "Public",
          preview_stills: {},
        });
        expect(await field("utility_lineup_preview_stills_url", empty)).toEqual(
          {},
        );
      });

      it("still links a still whose key is a JSON null, with no key or signature", async () => {
        const id = await filesLineup({
          visibility: "Public",
          preview_stills: { aim: null, land: "clips/utility/a/land.jpg" },
        });
        expect(await field("utility_lineup_preview_stills_url", id)).toEqual(
          base === null
            ? null
            : {
                aim: `${base}/?v=${RENDERED_EPOCH}`,
                land: await expectedUrl(
                  base,
                  "clips/utility/a/land.jpg",
                  RENDERED_EPOCH,
                  true,
                ),
              },
        );
      });
    });
  }
});

describe("utility lineup computed fields evaluation", () => {
  let db: SqlTestDb;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityLineupComputedFieldsPlanTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // A lineup carries its trajectory and run-up as jsonb; every field reads only
  // the columns it needs, so the row must never be built to answer one.
  it.each([
    ["can_view_utility_lineup", true],
    ["can_edit_utility_lineup", true],
    ["utility_lineup_my_vote", true],
    ["utility_lineup_is_favorited", true],
    ["utility_lineup_difficulty", false],
    ["utility_lineup_preview_url", false],
    ["utility_lineup_preview_thumbnail_url", false],
    ["utility_lineup_preview_stills_url", false],
    ["utility_lineup_smoke_voxels_url", false],
  ])("%s does not build the lineup row", async (fn, withSession) => {
    const plan = await db.postgres.query<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN (VERBOSE, COSTS OFF) SELECT public.${fn}(l${
        withSession
          ? `, '{"x-hasura-role":"user","x-hasura-user-id":"1"}'::json`
          : ""
      }) FROM utility_lineups l WHERE public.can_view_utility_lineup(l, '{}'::json)`,
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).not.toMatch(new RegExp(`(?<!_)${fn}\\(`));
    expect(text).not.toMatch(/(?<!_)can_view_utility_lineup\(/);
    expect(text).not.toMatch(/\bl\.\*|ROW\(/);
  });
});
