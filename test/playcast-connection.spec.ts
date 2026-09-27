import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const ADMIN_SESSION = JSON.stringify({
  "x-hasura-role": "administrator",
  "x-hasura-user-id": "1",
});

describe("get_match_tv_connection_string with playcast", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("PlaycastConnectionTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199700000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const setSetting = (name: string, value: string) =>
    postgres.query(
      `INSERT INTO settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = $2`,
      [name, value],
    );

  beforeEach(async () => {
    await postgres.query(
      "DELETE FROM settings WHERE name IN ('use_playcast', 'relay_domain', 'playcast_relay_url')",
    );
    await postgres.query(
      "UPDATE server_regions SET is_lan = false WHERE value = 'TestA'",
    );
    await setSetting("use_playcast", "true");
    await setSetting("relay_domain", "https://relay.example.com");
  });

  const liveMatch = async () => {
    const match = await fx.match({ type: "Duel" });
    await postgres.query(
      `UPDATE matches
          SET server_id = (SELECT id FROM servers WHERE region = 'TestA' LIMIT 1),
              started_at = now() - interval '1 hour'
        WHERE id = $1`,
      [match.id],
    );
    return match.id;
  };

  const connectString = async (matchId: string) => {
    const [row] = await postgres.query<Array<{ connect: string | null }>>(
      `SELECT get_match_tv_connection_string(m, $2::json) AS connect
         FROM matches m WHERE m.id = $1`,
      [matchId, ADMIN_SESSION],
    );
    return row.connect;
  };

  it("points viewers at the panel's relay by default", async () => {
    const matchId = await liveMatch();

    expect(await connectString(matchId)).toBe(
      `playcast "https://relay.example.com/${matchId}"`,
    );
  });

  it("points viewers at the edge worker once one is set", async () => {
    await setSetting("playcast_relay_url", "https://playcast.acme.gg");
    const matchId = await liveMatch();

    expect(await connectString(matchId)).toBe(
      `playcast "https://playcast.acme.gg/${matchId}"`,
    );
  });

  it("ignores an edge relay setting that could break out of the command", async () => {
    await setSetting("playcast_relay_url", 'https://playcast.acme.gg/"; quit');
    const matchId = await liveMatch();

    expect(await connectString(matchId)).toBe(
      `playcast "https://relay.example.com/${matchId}"`,
    );
  });

  it("keeps a LAN server's viewers on the panel's relay", async () => {
    await setSetting("playcast_relay_url", "https://playcast.acme.gg");
    await postgres.query(
      "UPDATE server_regions SET is_lan = true WHERE value = 'TestA'",
    );
    const matchId = await liveMatch();

    expect(await connectString(matchId)).toBe(
      `playcast "https://relay.example.com/${matchId}"`,
    );
  });
});
