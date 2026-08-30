import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// "Sign up with a friend, get drafted onto the same team." A party is every
// free agent in a tournament sharing a party_id -- the id of the 5stack lobby
// they signed up from. The draft treats it as one indivisible unit in BOTH of
// its stages, and the waitlist promotes it the same way.
describe("free agent parties (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentFreeAgentPartyTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561198300000000n);
    await fx.region("TestFAP");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const createTournament = async ({
    type = "Wingman",
    maxTeams = 4,
    // A stage refuses fewer than four teams per group, so four is the floor for
    // every pool in this suite.
    minTeams = 4,
    columns = {} as Record<string, string | number | boolean>,
  } = {}) => {
    const organizer = await fx.player();
    const optionsId = await fx.matchOptions({ type, regions: ["TestFAP"] });

    const names = Object.keys(columns);
    const extraCols = names.map((name) => `, "${name}"`).join("");
    const extraVals = names.map((_, i) => `, $${i + 5}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, registration_type${extraCols})
       VALUES ($1, now() + $2::interval, $3, $4, 'Setup', 'free_agents'${extraVals}) RETURNING id`,
      [
        fx.nextName("party"),
        "3 days",
        organizer,
        optionsId,
        ...names.map((name) => columns[name]),
      ],
    );

    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, $2, $3)`,
      [tournament.id, minTeams, maxTeams],
    );

    await runAsUser(postgres, organizer, "admin", (query) =>
      query(
        "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
        [tournament.id],
      ),
    );

    return { id: tournament.id, organizer };
  };

  // Minutes ago, so a signup order can be written in any insert order.
  const at = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  const register = async (
    tournamentId: string,
    steamId: string,
    minutesAgo: number,
    partyId?: string | null,
  ) => {
    await postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id, created_at, party_id)
       VALUES ($1, $2, $3::timestamptz, $4::uuid)`,
      [tournamentId, steamId, at(minutesAgo), partyId ?? null],
    );
    return steamId;
  };

  const newPartyId = async () => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      "SELECT gen_random_uuid()::text AS id",
    );
    return row.id;
  };

  const draft = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ created: number }>>(
      "SELECT draft_tournament_free_agent_teams($1) AS created",
      [tournamentId],
    );
    return Number(row.created);
  };

  const teamOf = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ tournament_team_id: string }>>(
      `SELECT tournament_team_id FROM tournament_team_roster
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );
    return row?.tournament_team_id ?? null;
  };

  type Agent = {
    player_steam_id: string;
    status: string;
    party_id: string | null;
    tournament_team_id: string | null;
  };

  const agent = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<Agent>>(
      `SELECT player_steam_id, status, party_id::text AS party_id, tournament_team_id
         FROM tournament_free_agents
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );
    return row;
  };

  const statusOf = async (tournamentId: string, steamId: string) =>
    (await agent(tournamentId, steamId))?.status ?? null;

  const rosterSize = async (teamId: string) => {
    const [row] = await postgres.query<Array<{ count: string }>>(
      "SELECT count(*)::text AS count FROM tournament_team_roster WHERE tournament_team_id = $1",
      [teamId],
    );
    return Number(row.count);
  };

  // Standing Competitive/Wingman ratings, hung off one finished match so
  // get_tournament_player_elo has something to read.
  const seedElo = async (
    ratings: Record<string, number>,
    type = "Competitive",
  ) => {
    const { matchId } = await fx.bareMatch();
    for (const [steamId, current] of Object.entries(ratings)) {
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, "type", current, change, created_at)
         VALUES ($1, $2, $3, $4, 0, now() - interval '30 days')`,
        [steamId, matchId, type, current],
      );
    }
  };

  describe("selection: priority is the earliest member's signup", () => {
    // The whole promise of a first-come pool. A party sits EXACTLY where its
    // founder sat: the newcomer rides along, and the founder is not pushed back
    // for having taken someone with them.
    it("queues a party where its founder queued, not where its newest member did", async () => {
      const t = await createTournament({ maxTeams: 3 });
      const party = await newPartyId();

      const early = [
        await register(t.id, await fx.player(), 20),
        await register(t.id, await fx.player(), 19),
        await register(t.id, await fx.player(), 18),
      ];
      const founder = await register(t.id, await fx.player(), 17, party);
      const middle = await register(t.id, await fx.player(), 16);
      const late = await register(t.id, await fx.player(), 15);
      const newcomer = await register(t.id, await fx.player(), 1, party);

      expect(await draft(t.id)).toBe(3);

      // Everyone who signed up before the founder is in: the party did not
      // sort ahead of them on the strength of nothing.
      for (const steamId of early) {
        expect(await statusOf(t.id, steamId)).toBe("drafted");
      }

      // The newcomer signed up 14 minutes after `late` and is in while `late`
      // waits, because the unit's priority is the founder's 17-minutes-ago.
      expect(await statusOf(t.id, newcomer)).toBe("drafted");
      expect(await statusOf(t.id, middle)).toBe("drafted");
      expect(await statusOf(t.id, late)).toBe("waitlisted");

      expect(await teamOf(t.id, newcomer)).toBe(await teamOf(t.id, founder));
    });

    it("waitlists a party that misses the cut as one unit, never in pieces", async () => {
      const t = await createTournament({ type: "Competitive", maxTeams: 1 });
      const party = await newPartyId();

      const solos = [
        await register(t.id, await fx.player(), 30),
        await register(t.id, await fx.player(), 29),
      ];
      const partied = [
        await register(t.id, await fx.player(), 28, party),
        await register(t.id, await fx.player(), 27, party),
        await register(t.id, await fx.player(), 26, party),
        await register(t.id, await fx.player(), 25, party),
      ];
      const fillers = [
        await register(t.id, await fx.player(), 20),
        await register(t.id, await fx.player(), 19),
        await register(t.id, await fx.player(), 18),
      ];

      // One team of five. The four-stack is third in line but only three slots
      // are left by the time it is reached, so it is skipped and the three
      // later solos take the remainder rather than the capacity being stranded.
      expect(await draft(t.id)).toBe(1);

      for (const steamId of [...solos, ...fillers]) {
        expect(await statusOf(t.id, steamId)).toBe("drafted");
      }

      for (const steamId of partied) {
        expect(await statusOf(t.id, steamId)).toBe("waitlisted");
        expect(await teamOf(t.id, steamId)).toBeNull();
      }
    });
  });

  describe("assignment: a party stays on one team", () => {
    it("keeps a pair and a trio each whole, with exact team sizes", async () => {
      const t = await createTournament({ type: "Competitive", maxTeams: 2 });
      const pair = await newPartyId();
      const trio = await newPartyId();

      const paired = [
        await register(t.id, await fx.player(), 30, pair),
        await register(t.id, await fx.player(), 29, pair),
      ];
      const trioed = [
        await register(t.id, await fx.player(), 28, trio),
        await register(t.id, await fx.player(), 27, trio),
        await register(t.id, await fx.player(), 26, trio),
      ];
      const solos: Array<string> = [];
      for (let i = 0; i < 5; i++) {
        solos.push(await register(t.id, await fx.player(), 25 - i));
      }

      expect(await draft(t.id)).toBe(2);

      const pairTeam = await teamOf(t.id, paired[0]);
      expect(await teamOf(t.id, paired[1])).toBe(pairTeam);

      const trioTeam = await teamOf(t.id, trioed[0]);
      expect(trioTeam).not.toBeNull();
      for (const steamId of trioed) {
        expect(await teamOf(t.id, steamId)).toBe(trioTeam);
      }

      const teams = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(teams).toHaveLength(2);
      for (const team of teams) {
        expect(await rosterSize(team.id)).toBe(5);
      }

      for (const steamId of solos) {
        expect(await statusOf(t.id, steamId)).toBe("drafted");
      }
    });

    it("still balances the teams with a top-heavy party in the pool", async () => {
      const t = await createTournament({ type: "Competitive", maxTeams: 2 });
      const party = await newPartyId();

      const ratings: Record<string, number> = {};
      const partied = [
        await register(t.id, await fx.player(), 40, party),
        await register(t.id, await fx.player(), 39, party),
      ];
      ratings[partied[0]] = 7000;
      ratings[partied[1]] = 7000;

      const soloRatings = [6000, 5500, 5000, 4500, 4000, 3500, 3000, 2000];
      for (const [index, rating] of soloRatings.entries()) {
        const steamId = await register(t.id, await fx.player(), 38 - index);
        ratings[steamId] = rating;
      }

      await seedElo(ratings);

      expect(await draft(t.id)).toBe(2);

      const totals = await postgres.query<Array<{ total: string }>>(
        `SELECT SUM(get_tournament_player_elo($1, ttr.player_steam_id))::text AS total
           FROM tournament_team_roster ttr
          WHERE ttr.tournament_id = $1
          GROUP BY ttr.tournament_team_id`,
        [t.id],
      );

      expect(totals).toHaveLength(2);

      const [a, b] = totals.map((row) => Number(row.total));
      // The pair is 14000 of the pool's 47500 and cannot be split, so perfect
      // balance is impossible; the greedy fill still lands inside a single
      // player's worth of rating.
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1000);
    });
  });

  describe("the party size cap", () => {
    it("refuses a signup that would push a party past the team size", async () => {
      const t = await createTournament();
      const party = await newPartyId();

      await register(t.id, await fx.player(), 10, party);
      await register(t.id, await fx.player(), 9, party);

      await expect(register(t.id, await fx.player(), 8, party)).rejects.toThrow(
        /size of a full team/i,
      );
    });

    it("refuses moving a third player into a full party", async () => {
      const t = await createTournament();
      const party = await newPartyId();

      await register(t.id, await fx.player(), 10, party);
      await register(t.id, await fx.player(), 9, party);
      const outsider = await register(t.id, await fx.player(), 8);

      await expect(
        postgres.query(
          `UPDATE tournament_free_agents SET party_id = $1::uuid
            WHERE tournament_id = $2 AND player_steam_id = $3`,
          [party, t.id, outsider],
        ),
      ).rejects.toThrow(/size of a full team/i);
    });
  });

  describe("leaving before the draft", () => {
    it("dissolves a party that is down to one member", async () => {
      const t = await createTournament();
      const party = await newPartyId();

      const leaver = await register(t.id, await fx.player(), 10, party);
      const stayer = await register(t.id, await fx.player(), 9, party);

      await postgres.query(
        `DELETE FROM tournament_free_agents
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, leaver],
      );

      expect((await agent(t.id, stayer)).party_id).toBeNull();
    });

    it("leaves a larger party intact, minus the member who left", async () => {
      const t = await createTournament({ type: "Competitive" });
      const party = await newPartyId();

      const leaver = await register(t.id, await fx.player(), 10, party);
      const rest = [
        await register(t.id, await fx.player(), 9, party),
        await register(t.id, await fx.player(), 8, party),
      ];

      await postgres.query(
        `DELETE FROM tournament_free_agents
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, leaver],
      );

      for (const steamId of rest) {
        expect((await agent(t.id, steamId)).party_id).toBe(party);
      }
    });
  });

  describe("waitlist promotion", () => {
    // Four solos drafted into two Wingman teams, with a waitlisted party of two
    // and (optionally) a waitlisted solo behind them.
    const draftedWithWaitlist = async ({ trailingSolo = true } = {}) => {
      const t = await createTournament({ maxTeams: 2 });
      const party = await newPartyId();

      const drafted: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        drafted.push(await register(t.id, await fx.player(), 40 - i));
      }

      const partied = [
        await register(t.id, await fx.player(), 30, party),
        await register(t.id, await fx.player(), 29, party),
      ];

      const solo = trailingSolo
        ? await register(t.id, await fx.player(), 20)
        : null;

      expect(await draft(t.id)).toBe(2);

      for (const steamId of partied) {
        expect(await statusOf(t.id, steamId)).toBe("waitlisted");
      }

      return { ...t, party, drafted, partied, solo };
    };

    it("gives a single vacancy to a later solo rather than splitting a party", async () => {
      const t = await draftedWithWaitlist();
      const team = (await teamOf(t.id, t.drafted[0]))!;

      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, t.drafted[0]],
      );

      expect(await teamOf(t.id, t.solo!)).toBe(team);
      for (const steamId of t.partied) {
        expect(await statusOf(t.id, steamId)).toBe("waitlisted");
      }
    });

    it("promotes a waitlisted party whole when the gap fits it", async () => {
      const t = await draftedWithWaitlist();
      const team = (await teamOf(t.id, t.drafted[0]))!;

      // Both roster rows in one statement: AFTER ROW triggers run at the end of
      // it, so the promotion sees a gap of two rather than two gaps of one.
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1",
        [team],
      );

      for (const steamId of t.partied) {
        expect(await teamOf(t.id, steamId)).toBe(team);
        expect(await statusOf(t.id, steamId)).toBe("drafted");
      }
    });

    // The deliberate compromise. A slot nobody can fill drops the team below the
    // minimum lineup and it is cut at seeding, which costs the waiting party the
    // bracket they are waiting on.
    it("splits the earliest party only when nothing else can fill the slot", async () => {
      const t = await draftedWithWaitlist({ trailingSolo: false });
      const team = (await teamOf(t.id, t.drafted[0]))!;

      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, t.drafted[0]],
      );

      expect(await teamOf(t.id, t.partied[0])).toBe(team);

      // The one left behind keeps the party id, so they stay a unit with their
      // original priority and take the next gap that opens anywhere.
      const remaining = await agent(t.id, t.partied[1]);
      expect(remaining.status).toBe("waitlisted");
      expect(remaining.party_id).toBe(t.party);

      // The ELO pass decides which generated team each drafted solo lands on,
      // so the other team has to be looked up rather than assumed.
      const [elsewhere] = await postgres.query<
        Array<{ tournament_team_id: string; player_steam_id: string }>
      >(
        `SELECT tournament_team_id, player_steam_id
           FROM tournament_team_roster
          WHERE tournament_id = $1 AND tournament_team_id <> $2
          LIMIT 1`,
        [t.id, team],
      );
      const other = elsewhere.tournament_team_id;

      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, elsewhere.player_steam_id],
      );

      expect(await teamOf(t.id, t.partied[1])).toBe(other);
    });
  });

  describe("check-in", () => {
    // check_in_setting = 'Players' makes every rostered player confirm for
    // themselves. A drafted party member is an ordinary roster row and gets no
    // special treatment from the roll-up.
    it("counts party members individually in Players mode", async () => {
      const t = await createTournament({
        maxTeams: 2,
        columns: { check_in_required: true, check_in_setting: "Players" },
      });
      const party = await newPartyId();

      const partied = [
        await register(t.id, await fx.player(), 40, party),
        await register(t.id, await fx.player(), 39, party),
      ];
      await register(t.id, await fx.player(), 38);
      await register(t.id, await fx.player(), 37);

      expect(await draft(t.id)).toBe(2);

      const team = (await teamOf(t.id, partied[0]))!;
      expect(await teamOf(t.id, partied[1])).toBe(team);

      const teamCheckedIn = async () => {
        const [row] = await postgres.query<
          Array<{ checked_in_at: string | null }>
        >("SELECT checked_in_at FROM tournament_teams WHERE id = $1", [team]);
        return row.checked_in_at !== null;
      };

      await postgres.query(
        `UPDATE tournament_teams SET checked_in_at = NULL WHERE id = $1`,
        [team],
      );
      await postgres.query(
        `UPDATE tournament_team_roster SET checked_in_at = NULL
          WHERE tournament_team_id = $1`,
        [team],
      );

      await postgres.query(
        `UPDATE tournament_team_roster SET checked_in_at = now()
          WHERE tournament_team_id = $1 AND player_steam_id = $2`,
        [team, partied[0]],
      );
      expect(await teamCheckedIn()).toBe(false);

      await postgres.query(
        `UPDATE tournament_team_roster SET checked_in_at = now()
          WHERE tournament_team_id = $1 AND player_steam_id = $2`,
        [team, partied[1]],
      );
      expect(await teamCheckedIn()).toBe(true);
    });
  });

  describe("the guards the draft already had", () => {
    it("shrinks a party by an ineligible member instead of dropping it", async () => {
      const t = await createTournament({ type: "Competitive", maxTeams: 2 });
      const party = await newPartyId();

      const partied = [
        await register(t.id, await fx.player(), 40, party),
        await register(t.id, await fx.player(), 39, party),
        await register(t.id, await fx.player(), 38, party),
      ];
      for (let i = 0; i < 3; i++) {
        await register(t.id, await fx.player(), 37 - i);
      }

      // Owning a team is the collision that hard-stalled the whole
      // RegistrationClosed transition once already: the draft has to skip this
      // member, and only this member.
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Owned', $2, $2)`,
        [t.id, partied[2]],
      );

      // Five drafted: the two remaining party members plus the three solos, on
      // the one team the bracket has room for beside the owner's.
      expect(await draft(t.id)).toBe(1);

      const team = await teamOf(t.id, partied[0]);
      expect(team).not.toBeNull();
      expect(await teamOf(t.id, partied[1])).toBe(team);
      expect(await teamOf(t.id, partied[2])).toBeNull();
      expect(await statusOf(t.id, partied[2])).toBe("registered");
    });

    it("stays idempotent once the teams are drafted", async () => {
      const t = await createTournament({ maxTeams: 2 });
      const party = await newPartyId();

      await register(t.id, await fx.player(), 40, party);
      await register(t.id, await fx.player(), 39, party);
      await register(t.id, await fx.player(), 38);
      await register(t.id, await fx.player(), 37);

      expect(await draft(t.id)).toBe(2);
      expect(await draft(t.id)).toBe(0);
    });
  });

  // The action is the only way a party is ever formed: party_id is not in the
  // user role's insert columns, so nobody can put themselves into someone
  // else's party through GraphQL.
  describe("joinTournamentAsFreeAgent with a lobby", () => {
    const notifyPlayers = jest.fn();

    const controller = () =>
      new TournamentsController(
        new Logger("FreeAgentPartyActionTest"),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { notifyPlayers } as never,
        postgres,
        { getConnection: () => ({}) } as never,
      );

    const createLobby = async (captain: string, mates: Array<string>) => {
      const lobbyId = await runAsUser(
        postgres,
        captain,
        "user",
        async (query) => {
          const [row] = (await query(
            "INSERT INTO lobbies (access) VALUES ('Private') RETURNING id",
          )) as Array<{ id: string }>;
          return row.id;
        },
      );

      for (const mate of mates) {
        await postgres.query(
          "INSERT INTO lobby_players (lobby_id, steam_id, status) VALUES ($1, $2, 'Accepted')",
          [lobbyId, mate],
        );
      }

      return lobbyId;
    };

    const join = (tournamentId: string, steamId: string) =>
      controller().joinTournamentAsFreeAgent({
        user: { steam_id: steamId, name: "Captain", role: "user" } as never,
        tournament_id: tournamentId,
        with_party: true,
      });

    beforeEach(() => notifyPlayers.mockReset());

    it("enters the whole lobby under the lobby id and drafts them together", async () => {
      const t = await createTournament({ maxTeams: 2 });
      const captain = await fx.player();
      const mate = await fx.player();
      const lobbyId = await createLobby(captain, [mate]);

      await expect(join(t.id, captain)).resolves.toEqual({ success: true });

      expect((await agent(t.id, captain)).party_id).toBe(lobbyId);
      expect((await agent(t.id, mate)).party_id).toBe(lobbyId);
      expect(notifyPlayers).toHaveBeenCalledWith(
        "TournamentPartySignup",
        expect.objectContaining({ steamIds: [mate] }),
      );

      await register(t.id, await fx.player(), 1);
      await register(t.id, await fx.player(), 1);

      expect(await draft(t.id)).toBe(2);
      expect(await teamOf(t.id, mate)).toBe(await teamOf(t.id, captain));
    });

    it("folds a friend who already signed up alone into the party", async () => {
      const t = await createTournament({ maxTeams: 2 });
      const captain = await fx.player();
      const mate = await register(t.id, await fx.player(), 30);
      await createLobby(captain, [mate]);

      await expect(join(t.id, captain)).resolves.toEqual({ success: true });

      const captainRow = await agent(t.id, captain);
      expect((await agent(t.id, mate)).party_id).toBe(captainRow.party_id);
      expect(captainRow.party_id).not.toBeNull();
    });

    it("refuses a lobby that could never fit one drafted team", async () => {
      const t = await createTournament({ maxTeams: 2 });
      const captain = await fx.player();
      const lobbyId = await createLobby(captain, [
        await fx.player(),
        await fx.player(),
      ]);

      await expect(join(t.id, captain)).rejects.toThrow(
        /cannot be drafted onto a team of 2/i,
      );

      const [entered] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text AS count FROM tournament_free_agents WHERE party_id = $1",
        [lobbyId],
      );
      expect(Number(entered.count)).toBe(0);
    });

    it("refuses when the caller is not the lobby captain", async () => {
      const t = await createTournament({ maxTeams: 2 });
      const captain = await fx.player();
      const mate = await fx.player();
      await createLobby(captain, [mate]);

      await expect(join(t.id, mate)).rejects.toThrow(/captain of this lobby/i);
    });
  });
});
