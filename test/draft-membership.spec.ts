import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Exercises the draft-room membership triggers (draft_game_players): join
// status resolution (host / approval / capacity waitlist), single-draft
// membership on accept, waitlist promotion, host succession, and draft
// teardown when players leave.
describe("draft room membership (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("DraftMembershipTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199800000000n);
    // The draft_games insert trigger refuses to create a lobby when no server
    // region is available.
    await fx.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM draft_games");
    await postgres.query("DELETE FROM players");
  });

  // Wingman drafts keep capacity at 4.
  const createDraft = async ({ requireApproval = false } = {}) => {
    const host = await fx.player();
    const [draft] = await postgres.query<
      Array<{ id: string; capacity: number }>
    >(
      `INSERT INTO draft_games (host_steam_id, type, require_approval)
       VALUES ($1, 'Wingman', $2) RETURNING id, capacity`,
      [host, requireApproval],
    );
    // The host joins their own room.
    await joinAs(draft.id, host);
    return { id: draft.id, host, capacity: Number(draft.capacity) };
  };

  const joinAs = async (draftId: string, steam: string) => {
    await runAsUser(postgres, steam, "user", (query) =>
      query(
        "INSERT INTO draft_game_players (draft_game_id, steam_id) VALUES ($1, $2)",
        [draftId, steam],
      ),
    );
    return steam;
  };

  const membership = (draftId: string) =>
    postgres.query<
      Array<{ steam_id: string; status: string; elo_snapshot: number }>
    >(
      `SELECT steam_id, status, elo_snapshot FROM draft_game_players
       WHERE draft_game_id = $1 ORDER BY joined_at`,
      [draftId],
    );

  const statusOf = async (draftId: string, steam: string) =>
    (await membership(draftId)).find((m) => m.steam_id === steam)?.status;

  it("resolves join statuses: host accepted, open joins accepted, approval rooms request", async () => {
    const open = await createDraft();
    expect(await statusOf(open.id, open.host)).toBe("Accepted");

    const joiner = await joinAs(open.id, await fx.player());
    expect(await statusOf(open.id, joiner)).toBe("Accepted");

    const gated = await createDraft({ requireApproval: true });
    const requester = await joinAs(gated.id, await fx.player());
    expect(await statusOf(gated.id, requester)).toBe("Requested");

    // The host adding someone bypasses approval.
    const invited = await fx.player();
    await runAsUser(postgres, gated.host, "user", (query) =>
      query(
        "INSERT INTO draft_game_players (draft_game_id, steam_id) VALUES ($1, $2)",
        [gated.id, invited],
      ),
    );
    expect(await statusOf(gated.id, invited)).toBe("Accepted");
  });

  it("snapshots a default 5000 elo for unrated joiners", async () => {
    const draft = await createDraft();
    const joiner = await joinAs(draft.id, await fx.player());
    const rows = await membership(draft.id);
    expect(
      Number(rows.find((m) => m.steam_id === joiner)!.elo_snapshot),
    ).toBe(5000);
  });

  it("waitlists joiners beyond capacity and promotes them as seats free up", async () => {
    const draft = await createDraft();
    const members = [draft.host];
    for (let i = 1; i < draft.capacity; i++) {
      members.push(await joinAs(draft.id, await fx.player()));
    }
    const latecomer = await joinAs(draft.id, await fx.player());
    expect(await statusOf(draft.id, latecomer)).toBe("Waitlist");

    // A seat frees up: the waitlisted player is promoted.
    await postgres.query(
      "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [draft.id, members[1]],
    );
    expect(await statusOf(draft.id, latecomer)).toBe("Accepted");
  });

  it("accepting into a new draft pulls the player out of other open drafts", async () => {
    const first = await createDraft();
    const second = await createDraft();
    const drifter = await fx.player();

    await joinAs(first.id, drifter);
    await joinAs(second.id, drifter);

    expect(await statusOf(first.id, drifter)).toBeUndefined();
    expect(await statusOf(second.id, drifter)).toBe("Accepted");
  });

  it("the host leaving hands the room to the oldest accepted member", async () => {
    const draft = await createDraft();
    const heir = await joinAs(draft.id, await fx.player());
    await joinAs(draft.id, await fx.player());

    await postgres.query(
      "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [draft.id, draft.host],
    );

    const [game] = await postgres.query<Array<{ host_steam_id: string }>>(
      "SELECT host_steam_id FROM draft_games WHERE id = $1",
      [draft.id],
    );
    expect(game.host_steam_id).toBe(heir);
  });

  it("the last player leaving dissolves the draft", async () => {
    const draft = await createDraft();
    await postgres.query(
      "DELETE FROM draft_game_players WHERE draft_game_id = $1",
      [draft.id],
    );
    const rows = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM draft_games WHERE id = $1",
      [draft.id],
    );
    expect(rows.length).toBe(0);
  });

  it("leaving a draft that has started tears the whole draft down", async () => {
    const draft = await createDraft();
    const quitter = await joinAs(draft.id, await fx.player());
    await postgres.query(
      "UPDATE draft_games SET status = 'Drafting' WHERE id = $1",
      [draft.id],
    );

    await postgres.query(
      "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [draft.id, quitter],
    );

    const rows = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM draft_games WHERE id = $1",
      [draft.id],
    );
    expect(rows.length).toBe(0);
  });
});
