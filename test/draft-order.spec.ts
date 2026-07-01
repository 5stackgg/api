import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { HasuraService } from "./../src/hasura/hasura.service";
import { PostgresService } from "./../src/postgres/postgres.service";

describe("draft game pick order (SQL-driven)", () => {
  const IMAGE = "timescale/timescaledb:latest-pg17";

  let container: StartedPostgreSqlContainer;
  let postgres: PostgresService;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase("hasura")
      .withUsername("hasura")
      .withPassword("hasura")
      .withCommand([
        "postgres",
        "-c",
        "shared_preload_libraries=timescaledb,pg_stat_statements",
      ])
      .start();

    const configService = new ConfigService({
      postgres: {
        connections: {
          default: {
            host: container.getHost(),
            port: container.getPort(),
            user: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
            max: 5,
          },
        },
      },
      app: {
        demosDomain: "demos.test",
        relayDomain: "relay.test",
      },
    });

    const logger = new Logger("DraftOrderTest");
    postgres = new PostgresService(configService, logger);

    await postgres.query("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE");

    const hasuraService = new HasuraService(
      logger,
      null as never,
      configService,
      postgres,
    );

    await hasuraService.setup();
  }, 600_000);

  afterAll(async () => {
    await (
      postgres as unknown as { pool: { end(): Promise<void> } }
    )?.pool?.end();
    await container?.stop();
  });

  const nextSteam = () => (76561190000000000n + BigInt(++seq)).toString();

  const seedPlayer = async (name: string) => {
    const steam = nextSteam();
    await postgres.query("INSERT INTO players (steam_id, name) VALUES ($1, $2)", [
      steam,
      name,
    ]);
    return steam;
  };

  const createDraft = async (type: string, draftOrder: string) => {
    const host = await seedPlayer("host");
    const [{ id, capacity }] = await postgres.query<
      Array<{ id: string; capacity: number }>
    >(
      `INSERT INTO draft_games (host_steam_id, type, draft_order, status)
       VALUES ($1, $2, $3, 'Open') RETURNING id, capacity`,
      [host, type, draftOrder],
    );

    const cap1 = await seedPlayer("cap1");
    const cap2 = await seedPlayer("cap2");
    await postgres.query(
      `INSERT INTO draft_game_players (draft_game_id, steam_id, is_captain, lineup, status)
       VALUES ($1, $2, true, 1, 'Accepted')`,
      [id, cap1],
    );
    await postgres.query(
      `INSERT INTO draft_game_players (draft_game_id, steam_id, is_captain, lineup, status)
       VALUES ($1, $2, true, 2, 'Accepted')`,
      [id, cap2],
    );

    const pool: Array<string> = [];
    for (let i = 0; i < capacity - 2; i++) {
      const steam = await seedPlayer(`p${i}`);
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, status)
         VALUES ($1, $2, 'Accepted')`,
        [id, steam],
      );
      pool.push(steam);
    }

    await postgres.query("UPDATE draft_games SET status = 'Drafting' WHERE id = $1", [
      id,
    ]);
    await postgres.query(
      `UPDATE draft_games
       SET current_pick_lineup = get_draft_game_picking_lineup_id(draft_games)
       WHERE id = $1`,
      [id],
    );

    return { id, capacity: Number(capacity), cap1, cap2, pool };
  };

  const getPattern = async (id: string) => {
    const [{ pattern }] = await postgres.query<Array<{ pattern: number[] }>>(
      "SELECT get_draft_game_pattern(draft_games) AS pattern FROM draft_games WHERE id = $1",
      [id],
    );
    return pattern.map(Number);
  };

  const gameState = async (id: string) => {
    const [row] = await postgres.query<
      Array<{ current_pick_lineup: number | null; status: string }>
    >("SELECT current_pick_lineup, status FROM draft_games WHERE id = $1", [id]);
    return row;
  };

  const playerSlot = async (id: string, steam: string) => {
    const [row] = await postgres.query<
      Array<{ lineup: number | null; pick_order: number | null }>
    >(
      "SELECT lineup, pick_order FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [id, steam],
    );
    return row;
  };

  // set_config is transaction-local, so the pick must share tbi's connection
  const pickAs = (id: string, captainSteam: string, pickedSteam: string) =>
    postgres.transaction(async (client) => {
      await client.query("SELECT set_config('hasura.user', $1, true)", [
        JSON.stringify({ "x-hasura-user-id": captainSteam }),
      ]);
      await client.query(
        "INSERT INTO draft_game_picks (draft_game_id, picked_steam_id) VALUES ($1, $2)",
        [id, pickedSteam],
      );
    });

  const runDraft = async (draft: {
    id: string;
    capacity: number;
    cap1: string;
    cap2: string;
    pool: Array<string>;
  }) => {
    const pattern = await getPattern(draft.id);
    const realPicks = draft.capacity - 2 - 1;
    const remaining = [...draft.pool];
    const pickedByPosition: Array<string> = [];

    for (let p = 0; p < realPicks; p++) {
      expect((await gameState(draft.id)).current_pick_lineup).toBe(pattern[p]);

      const captain = pattern[p] === 1 ? draft.cap1 : draft.cap2;
      const picked = remaining.shift() as string;
      pickedByPosition.push(picked);
      await pickAs(draft.id, captain, picked);
    }

    return { pattern, pickedByPosition, autoPlayer: remaining[0] };
  };

  describe("get_draft_game_pattern", () => {
    it("Alternating (Comp) -> 1,2,1,2,1,2,1,2", async () => {
      const d = await createDraft("Competitive", "Alternating");
      expect(await getPattern(d.id)).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
    });

    it("FrontLoaded (Comp) -> 1,2,2,1,2,1,2,1", async () => {
      const d = await createDraft("Competitive", "FrontLoaded");
      expect(await getPattern(d.id)).toEqual([1, 2, 2, 1, 2, 1, 2, 1]);
    });

    it("Snake (Comp) -> 1,2,2,1,1,2,2,1", async () => {
      const d = await createDraft("Competitive", "Snake");
      expect(await getPattern(d.id)).toEqual([1, 2, 2, 1, 1, 2, 2, 1]);
    });

    it("Wingman reduces to 1,2 for every order", async () => {
      for (const order of ["Alternating", "FrontLoaded", "Snake"]) {
        const d = await createDraft("Wingman", order);
        expect(await getPattern(d.id)).toEqual([1, 2]);
      }
    });
  });

  describe.each([
    ["Alternating", [1, 2, 1, 2, 1, 2, 1, 2]],
    ["FrontLoaded", [1, 2, 2, 1, 2, 1, 2, 1]],
    ["Snake", [1, 2, 2, 1, 1, 2, 2, 1]],
  ] as Array<[string, number[]]>)(
    "full %s Comp draft",
    (order, expectedPattern) => {
      it("advances turns and fills balanced 4/4 rosters", async () => {
        const d = await createDraft("Competitive", order);
        const { pattern, pickedByPosition, autoPlayer } = await runDraft(d);

        expect(pattern).toEqual(expectedPattern);

        for (let p = 0; p < pickedByPosition.length; p++) {
          expect((await playerSlot(d.id, pickedByPosition[p])).lineup).toBe(
            pattern[p],
          );
        }

        expect((await playerSlot(d.id, autoPlayer)).lineup).toBe(
          pattern[pattern.length - 1],
        );

        const state = await gameState(d.id);
        expect(state.status).toBe("CreatingMatch");
        expect(state.current_pick_lineup).toBeNull();

        const counts = await postgres.query<
          Array<{ lineup: number; c: number }>
        >(
          `SELECT lineup, count(*)::int AS c FROM draft_game_players
           WHERE draft_game_id = $1 GROUP BY lineup ORDER BY lineup`,
          [d.id],
        );
        expect(counts).toEqual([
          { lineup: 1, c: 5 },
          { lineup: 2, c: 5 },
        ]);
      });
    },
  );

  describe("turn enforcement", () => {
    it("rejects a pick from the captain whose turn it is not", async () => {
      const d = await createDraft("Competitive", "Snake");
      await expect(pickAs(d.id, d.cap2, d.pool[0])).rejects.toThrow(
        /not your turn/i,
      );
    });

    it("auto-assigns the last player instead of forcing a final pick", async () => {
      // Wingman: captain 1 makes the only real pick, the rest is auto-assigned
      const d = await createDraft("Wingman", "FrontLoaded");
      const [first, second] = d.pool;
      await pickAs(d.id, d.cap1, first);

      expect((await playerSlot(d.id, first)).lineup).toBe(1);
      expect((await playerSlot(d.id, second)).lineup).toBe(2);
      expect((await gameState(d.id)).status).toBe("CreatingMatch");
    });
  });
});
