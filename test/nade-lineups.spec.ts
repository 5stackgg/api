import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The nade library's guarantees, run as real SQL against a migrated database.
// Visibility is the whole product surface here -- a lineup leaking out of a
// private book or a team book is the failure that matters -- so it is asserted
// at the function/constraint level rather than through a service.
describe("nade lineups (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("NadeLineupsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199700000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM nade_lineups");
    await postgres.query("DELETE FROM nade_collections");
  });

  const session = (steamId: string | null, role = "user") =>
    JSON.stringify({
      "x-hasura-role": role,
      ...(steamId ? { "x-hasura-user-id": steamId } : {}),
    });

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      nade_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      throw_strength: "Full",
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
      `INSERT INTO nade_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  async function canView(
    lineupId: string,
    viewer: string | null,
    role = "user",
  ) {
    const [row] = await postgres.query<Array<{ ok: boolean }>>(
      `SELECT can_view_nade_lineup(l, $2::json) AS ok
         FROM nade_lineups l WHERE l.id = $1`,
      [lineupId, session(viewer, role)],
    );
    return row.ok;
  }

  async function canEdit(
    lineupId: string,
    viewer: string | null,
    role = "user",
  ) {
    const [row] = await postgres.query<Array<{ ok: boolean }>>(
      `SELECT can_edit_nade_lineup(l, $2::json) AS ok
         FROM nade_lineups l WHERE l.id = $1`,
      [lineupId, session(viewer, role)],
    );
    return row.ok;
  }

  describe("map keying", () => {
    it("rejects a map that does not exist", async () => {
      const author = await fx.player();
      await expect(
        insertLineup(author, { map_name: "de_notamap" }),
      ).rejects.toThrow(/Unknown map/);
    });

    // maps is UNIQUE (name, type), so the same de_* name may hold a row per
    // match type. Keying the library on the name means a lineup stays valid no
    // matter how many type rows exist, which is why this inserts a second one
    // and expects nothing to change.
    it("resolves a map by name regardless of how many match types register it", async () => {
      const author = await fx.player();
      await expect(insertLineup(author)).resolves.toBeTruthy();

      await postgres.query(
        `INSERT INTO maps (name, type, enabled, active_pool)
         VALUES ('de_mirage', 'Wingman', true, false)
         ON CONFLICT (name, type) DO NOTHING`,
      );
      await expect(insertLineup(author)).resolves.toBeTruthy();
    });
  });

  describe("visibility", () => {
    it("keeps a private lineup to its author", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const id = await insertLineup(author);

      expect(await canView(id, author)).toBe(true);
      expect(await canView(id, stranger)).toBe(false);
      expect(await canView(id, null, "guest")).toBe(false);
    });

    it("shows a public lineup to everyone including guests", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const id = await insertLineup(author, { visibility: "Public" });

      expect(await canView(id, author)).toBe(true);
      expect(await canView(id, stranger)).toBe(true);
      expect(await canView(id, null, "guest")).toBe(true);
    });

    it("shows a team lineup to the team and nobody else", async () => {
      const team = await fx.team(1);
      const [mate] = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2 LIMIT 1`,
        [team.id, team.owner],
      );
      const stranger = await fx.player();
      const id = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      expect(await canView(id, team.owner)).toBe(true);
      expect(await canView(id, mate.player_steam_id)).toBe(true);
      expect(await canView(id, stranger)).toBe(false);
      expect(await canView(id, null, "guest")).toBe(false);
    });

    it("refuses Team visibility without a team", async () => {
      const author = await fx.player();
      await expect(
        insertLineup(author, { visibility: "Team" }),
      ).rejects.toThrow(/nade_lineups_team_scope_chk/);
    });

    it("refuses publishing into a team the author is not on", async () => {
      const team = await fx.team();
      const outsider = await fx.player();
      await expect(
        insertLineup(outsider, { visibility: "Team", team_id: team.id }),
      ).rejects.toThrow(/not on that team/);
    });

    it("hides an archived lineup from everyone but its author", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const id = await insertLineup(author, {
        visibility: "Public",
        archived_at: new Date().toISOString(),
      });

      expect(await canView(id, author)).toBe(true);
      expect(await canView(id, stranger)).toBe(false);
    });

    it("lets a moderator see a private lineup", async () => {
      const author = await fx.player();
      const mod = await fx.player();
      const id = await insertLineup(author);
      expect(await canView(id, mod, "moderator")).toBe(true);
    });
  });

  describe("editing", () => {
    it("lets only the author edit their own lineup", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const id = await insertLineup(author);

      expect(await canEdit(id, author)).toBe(true);
      expect(await canEdit(id, stranger)).toBe(false);
    });

    // A team book is the team's to curate, so an admin can fix a lineup whose
    // author has stopped maintaining it.
    it("lets a team admin edit a team lineup but a plain member not", async () => {
      const team = await fx.team(1);
      const [mate] = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2 LIMIT 1`,
        [team.id, team.owner],
      );
      const id = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      expect(await canEdit(id, team.owner)).toBe(true);
      expect(await canEdit(id, mate.player_steam_id)).toBe(false);
    });
  });

  describe("counters", () => {
    it("tracks up and down votes", async () => {
      const author = await fx.player();
      const a = await fx.player();
      const b = await fx.player();
      const id = await insertLineup(author, { visibility: "Public" });

      await postgres.query(
        "INSERT INTO nade_lineup_votes (nade_lineup_id, steam_id, vote) VALUES ($1, $2, 1)",
        [id, a],
      );
      await postgres.query(
        "INSERT INTO nade_lineup_votes (nade_lineup_id, steam_id, vote) VALUES ($1, $2, -1)",
        [id, b],
      );

      let [row] = await postgres.query<
        Array<{ upvotes: number; downvotes: number }>
      >("SELECT upvotes, downvotes FROM nade_lineups WHERE id = $1", [id]);
      expect(row.upvotes).toBe(1);
      expect(row.downvotes).toBe(1);

      // Flipping a vote must move both counters, not just add to one.
      await postgres.query(
        "UPDATE nade_lineup_votes SET vote = 1 WHERE nade_lineup_id = $1 AND steam_id = $2",
        [id, b],
      );
      [row] = await postgres.query<
        Array<{ upvotes: number; downvotes: number }>
      >("SELECT upvotes, downvotes FROM nade_lineups WHERE id = $1", [id]);
      expect(row.upvotes).toBe(2);
      expect(row.downvotes).toBe(0);

      await postgres.query(
        "DELETE FROM nade_lineup_votes WHERE nade_lineup_id = $1",
        [id],
      );
      [row] = await postgres.query<
        Array<{ upvotes: number; downvotes: number }>
      >("SELECT upvotes, downvotes FROM nade_lineups WHERE id = $1", [id]);
      expect(row.upvotes).toBe(0);
      expect(row.downvotes).toBe(0);
    });

    it("tracks favorites", async () => {
      const author = await fx.player();
      const fan = await fx.player();
      const id = await insertLineup(author, { visibility: "Public" });

      await postgres.query(
        "INSERT INTO nade_lineup_favorites (nade_lineup_id, steam_id) VALUES ($1, $2)",
        [id, fan],
      );
      let [row] = await postgres.query<Array<{ favorites: number }>>(
        "SELECT favorites FROM nade_lineups WHERE id = $1",
        [id],
      );
      expect(row.favorites).toBe(1);

      await postgres.query(
        "DELETE FROM nade_lineup_favorites WHERE nade_lineup_id = $1 AND steam_id = $2",
        [id, fan],
      );
      [row] = await postgres.query<Array<{ favorites: number }>>(
        "SELECT favorites FROM nade_lineups WHERE id = $1",
        [id],
      );
      expect(row.favorites).toBe(0);
    });

    it("reports the viewer's own vote and favorite state", async () => {
      const author = await fx.player();
      const fan = await fx.player();
      const id = await insertLineup(author, { visibility: "Public" });

      await postgres.query(
        "INSERT INTO nade_lineup_votes (nade_lineup_id, steam_id, vote) VALUES ($1, $2, 1)",
        [id, fan],
      );
      await postgres.query(
        "INSERT INTO nade_lineup_favorites (nade_lineup_id, steam_id) VALUES ($1, $2)",
        [id, fan],
      );

      const [row] = await postgres.query<
        Array<{ my_vote: number | null; is_favorited: boolean }>
      >(
        `SELECT nade_lineup_my_vote(l, $2::json) AS my_vote,
                nade_lineup_is_favorited(l, $2::json) AS is_favorited
           FROM nade_lineups l WHERE l.id = $1`,
        [id, session(fan)],
      );
      expect(row.my_vote).toBe(1);
      expect(row.is_favorited).toBe(true);

      const [none] = await postgres.query<
        Array<{ my_vote: number | null; is_favorited: boolean }>
      >(
        `SELECT nade_lineup_my_vote(l, $2::json) AS my_vote,
                nade_lineup_is_favorited(l, $2::json) AS is_favorited
           FROM nade_lineups l WHERE l.id = $1`,
        [id, session(null, "guest")],
      );
      expect(none.my_vote).toBeNull();
      expect(none.is_favorited).toBe(false);
    });
  });

  describe("dedupe bucket", () => {
    // Two people who found the same smoke from roughly the same spot should
    // land in one bucket, so the UI can say "12 people run this".
    it("buckets near-identical setups together and distinct ones apart", async () => {
      const author = await fx.player();
      const a = await insertLineup(author);
      const b = await insertLineup(author, { origin_x: -1900, land_x: -550 });
      const c = await insertLineup(author, { origin_x: 400, land_x: 900 });

      const rows = await postgres.query<
        Array<{ id: string; lineup_bucket: string }>
      >("SELECT id, lineup_bucket FROM nade_lineups WHERE id = ANY($1)", [
        [a, b, c],
      ]);
      const bucket = (id: string) =>
        rows.find((r) => r.id === id)!.lineup_bucket;

      expect(bucket(a)).toBe(bucket(b));
      expect(bucket(a)).not.toBe(bucket(c));
    });
  });

  // teams.id is ON DELETE SET NULL while the team-scope CHECK still demands a
  // team, so without the trigger's demotion the CHECK aborts the *team*
  // deletion rather than this row.
  describe("team deletion", () => {
    it("demotes a team lineup to private instead of blocking the delete", async () => {
      const team = await fx.team();
      const id = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      await expect(
        postgres.query("DELETE FROM teams WHERE id = $1", [team.id]),
      ).resolves.toBeDefined();

      const [row] = await postgres.query<
        Array<{ visibility: string; team_id: string | null }>
      >("SELECT visibility, team_id FROM nade_lineups WHERE id = $1", [id]);
      expect(row.visibility).toBe("Private");
      expect(row.team_id).toBeNull();
    });

    it("demotes a team collection the same way", async () => {
      const team = await fx.team();
      const [collection] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO nade_collections (name, owner_steam_id, team_id, visibility)
         VALUES ('Team book', $1, $2, 'Team') RETURNING id`,
        [team.owner, team.id],
      );

      await expect(
        postgres.query("DELETE FROM teams WHERE id = $1", [team.id]),
      ).resolves.toBeDefined();

      const [row] = await postgres.query<Array<{ visibility: string }>>(
        "SELECT visibility FROM nade_collections WHERE id = $1",
        [collection.id],
      );
      expect(row.visibility).toBe("Private");
    });
  });

  describe("collections", () => {
    it("cascades items when a lineup or collection goes away", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);
      const [collection] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO nade_collections (name, owner_steam_id)
         VALUES ('My book', $1) RETURNING id`,
        [owner],
      );
      await postgres.query(
        `INSERT INTO nade_collection_items (collection_id, nade_lineup_id)
         VALUES ($1, $2)`,
        [collection.id, lineup],
      );

      await postgres.query("DELETE FROM nade_lineups WHERE id = $1", [lineup]);
      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM nade_collection_items WHERE collection_id = $1",
        [collection.id],
      );
      expect(Number(count)).toBe(0);
    });
  });

  // confidence is a claim that something MEASURED these coordinates, and it is
  // half of the plugin's exact-ghost gate. The web editor cannot set it (or
  // origin_source) at all, so the column default and the trigger are the only
  // things standing between a hand-typed lineup and a row that says an engine
  // recorded it.
  describe("confidence", () => {
    const SEED = {
      initial_pos_x: -1900,
      initial_pos_y: 930,
      initial_pos_z: -100,
      initial_vel_x: 500,
      initial_vel_y: 200,
      initial_vel_z: 300,
    };

    const confidenceOf = async (lineupId: string) => {
      const [row] = await postgres.query<
        Array<{ confidence: string; origin_source: string }>
      >("SELECT confidence, origin_source FROM nade_lineups WHERE id = $1", [
        lineupId,
      ]);
      return row;
    };

    // Exactly what a web-editor insert looks like: no origin_source, no
    // confidence, no seed -- both columns are absent from every non-admin
    // insert permission.
    it("does not call a hand-authored lineup exact", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);

      expect(await confidenceOf(lineup)).toEqual({
        confidence: "low",
        origin_source: "editor",
      });
    });

    it("refuses an explicit exact on a seedless hand-authored lineup", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, { confidence: "exact" });

      expect((await confidenceOf(lineup)).confidence).toBe("low");
    });

    // The server watched the grenade fly. That is a measurement whether or not
    // it also captured the engine's seed, so the ingest path keeps working.
    it("keeps a plugin recording exact without a seed", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, {
        origin_source: "plugin",
        confidence: "exact",
      });

      expect((await confidenceOf(lineup)).confidence).toBe("exact");
    });

    it("lets any origin be exact once it carries a full seed", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, {
        confidence: "exact",
        ...SEED,
      });

      expect((await confidenceOf(lineup)).confidence).toBe("exact");
    });

    it("calls a demo-mined lineup derived rather than low", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, {
        origin_source: "demo",
        confidence: "exact",
      });

      expect((await confidenceOf(lineup)).confidence).toBe("derived");
    });

    // An update is the other way in: an admin may edit the seed off a row, and
    // the claim has to fall with it.
    it("demotes when the seed is taken away", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, {
        confidence: "exact",
        ...SEED,
      });

      await postgres.query(
        "UPDATE nade_lineups SET initial_vel_z = NULL WHERE id = $1",
        [lineup],
      );

      expect((await confidenceOf(lineup)).confidence).toBe("low");
    });

    it("leaves a partial seed unable to hold exact", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, {
        confidence: "exact",
        initial_pos_x: -1900,
        initial_pos_y: 930,
        initial_pos_z: -100,
      });

      expect((await confidenceOf(lineup)).confidence).toBe("low");
    });
  });
});
