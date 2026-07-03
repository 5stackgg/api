import { PostgresService } from "../../src/postgres/postgres.service";
import { runAsUser } from "./sql-test-db";

// Typed fixture builders shared by the SQL specs. One Fixtures instance per
// suite: it owns a steam-id sequence so every player it mints is unique within
// the suite, and every builder returns the ids the assertions need.
//
// Builders lean on the real triggers wherever the trigger IS the seeding
// mechanism (teams enroll their owner, matches provision lineups, lobbies
// enroll their creator) so specs exercise production behavior, not a parallel
// insert path.

export type MatchOptionsOverrides = {
  type?: string;
  bestOf?: number;
  mr?: number;
  mapVeto?: boolean;
  regionVeto?: boolean;
  regions?: Array<string>;
  mapPoolId?: string;
  substitutes?: number;
};

export type MatchRow = {
  id: string;
  lineup_1_id: string;
  lineup_2_id: string;
  status: string;
  region: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  cancels_at: Date | null;
  scheduled_at: Date | null;
  winning_lineup_id: string | null;
};

export type KillOptions = {
  weapon?: string;
  headshot?: boolean;
  time?: string;
};

export class Fixtures {
  private seq = 0;

  constructor(
    private readonly postgres: PostgresService,
    // Distinct bases keep suites from ever colliding on steam ids, even if
    // fixtures are shared across parallel workers hitting one database.
    private readonly steamBase = 76561190000000000n,
  ) {}

  nextSteam(): string {
    return (this.steamBase + BigInt(++this.seq)).toString();
  }

  nextName(prefix: string): string {
    return `${prefix}${this.seq}`;
  }

  async player(name?: string): Promise<string> {
    const steam = this.nextSteam();
    await this.postgres.query(
      "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
      [steam, name ?? `p${this.seq}`],
    );
    return steam;
  }

  async players(count: number): Promise<Array<string>> {
    const steams: Array<string> = [];
    for (let i = 0; i < count; i++) {
      steams.push(await this.player());
    }
    return steams;
  }

  // A Custom pool holding exactly `size` maps, so setup_match_maps
  // materializes match_maps when size == best_of and defers to the veto
  // otherwise. Maps are pulled deterministically (ordered by name); pass an
  // offset to build a second pool with disjoint maps.
  async mapPool(
    size: number,
    { mapType = "Competitive", offset = 0 } = {},
  ): Promise<{ poolId: string; mapIds: Array<string> }> {
    const [pool] = await this.postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    const maps = await this.postgres.query<Array<{ map_id: string }>>(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, id FROM maps WHERE type = $2 ORDER BY name OFFSET $3 LIMIT $4
       RETURNING map_id`,
      [pool.id, mapType, offset, size],
    );
    return { poolId: pool.id, mapIds: maps.map((m) => m.map_id) };
  }

  // The install-seeded pool for a match type (Competitive: 7 maps, Wingman: 6,
  // Duel: 6) — larger than any best_of, so maps stay with the veto.
  async seededPool(type: string): Promise<string> {
    const [pool] = await this.postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = $1 AND seed = true",
      [type],
    );
    return pool.id;
  }

  async matchOptions(over: MatchOptionsOverrides = {}): Promise<string> {
    const type = over.type ?? "Competitive";
    const mapPoolId =
      over.mapPoolId ??
      (await this.seededPool(
        type === "Duel" || type === "Wingman" ? type : "Competitive",
      ));
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options
         (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        over.mr ?? 12,
        over.bestOf ?? 1,
        type,
        mapPoolId,
        over.mapVeto ?? false,
        over.regionVeto ?? true,
        over.regions ?? ["TestA"],
        over.substitutes ?? 0,
      ],
    );
    return row.id;
  }

  // A match created through the real tbi/tai triggers: lineups provisioned,
  // maps materialized when the pool allows, region auto-selected when single.
  async match(
    options?: string | MatchOptionsOverrides,
  ): Promise<MatchRow & { options_id: string }> {
    const optionsId =
      typeof options === "string"
        ? options
        : await this.matchOptions(options ?? {});
    const [match] = await this.postgres.query<Array<MatchRow>>(
      "INSERT INTO matches (match_options_id) VALUES ($1) RETURNING *",
      [optionsId],
    );
    return { ...match, options_id: optionsId };
  }

  // A minimal optionless match (source '5stack') plus one map — the shape the
  // demo-parser writes for imported/finished games; carries kills and rounds.
  async bareMatch(
    endedAt: string | null = null,
  ): Promise<{ matchId: string; mapId: string }> {
    const [l1] = await this.postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [l2] = await this.postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [match] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO matches (lineup_1_id, lineup_2_id, source, ended_at)
       VALUES ($1, $2, '5stack', $3) RETURNING id`,
      [l1.id, l2.id, endedAt],
    );
    const [map] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );
    return { matchId: match.id, mapId: map.id };
  }

  async lineupPlayer(lineupId: string, steam?: string): Promise<string> {
    const steamId = steam ?? (await this.player());
    await this.postgres.query(
      "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
      [lineupId, steamId],
    );
    return steamId;
  }

  // A team whose roster is the owner (enrolled by tai_teams) plus `mates`
  // extra players added under an admin session.
  async team(mates = 0): Promise<{ id: string; owner: string }> {
    const owner = await this.player();
    const [team] = await this.postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [this.nextName("team"), owner],
    );
    for (let i = 0; i < mates; i++) {
      const mate = await this.player();
      await runAsUser(this.postgres, owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
          [team.id, mate],
        ),
      );
    }
    return { id: team.id, owner };
  }

  async season(start: string, end: string | null = null): Promise<string> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      "INSERT INTO seasons (starts_at, ends_at) VALUES ($1, $2) RETURNING id",
      [start, end],
    );
    return row.id;
  }

  async enableSeasons(enabled = true): Promise<void> {
    await this.postgres.query(
      `INSERT INTO settings (name, value) VALUES ('public.seasons_enabled', $1)
       ON CONFLICT (name) DO UPDATE SET value = $1`,
      [String(enabled)],
    );
  }

  async kill(
    ctx: { matchId: string; mapId: string },
    attacker: string,
    victim: string,
    opts: KillOptions = {},
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO player_kills
         (match_id, match_map_id, round, attacker_steam_id, attacked_steam_id,
          attacked_team, attacked_location, "with", hitgroup, "time", headshot)
       VALUES ($1, $2, 1, $3, $4, 'CT', 'site', $5, 'head', $6, $7)`,
      [
        ctx.matchId,
        ctx.mapId,
        attacker,
        victim,
        opts.weapon ?? "ak47",
        opts.time ?? new Date().toISOString(),
        opts.headshot ?? false,
      ],
    );
  }

  async assist(
    ctx: { matchId: string; mapId: string },
    assister: string,
    victim: string,
    time?: string,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO player_assists
         (match_id, match_map_id, "time", round, attacker_steam_id, attacker_team, attacked_steam_id, attacked_team)
       VALUES ($1, $2, $3, 1, $4, 'TERRORIST', $5, 'CT')`,
      [ctx.matchId, ctx.mapId, time ?? new Date().toISOString(), assister, victim],
    );
  }

  // Two score snapshots (an early one and the final) so consumers of
  // "latest round wins" ordering are genuinely exercised.
  async roundScore(
    mapId: string,
    lineup1Score: number,
    lineup2Score: number,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO match_map_rounds
         (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
          "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
          lineup_1_side, lineup_2_side, winning_side)
       VALUES
         ($1, 1, 1, 0, 800, 800, now() - interval '40 minutes', 3, 3, 'CT', 'TERRORIST', 'CT'),
         ($1, 2, $2, $3, 16000, 9000, now(), 3, 3, 'TERRORIST', 'CT', 'TERRORIST')`,
      [mapId, lineup1Score, lineup2Score],
    );
  }

  async finishMap(mapId: string): Promise<void> {
    await this.postgres.query(
      "UPDATE match_maps SET status = 'Finished' WHERE id = $1",
      [mapId],
    );
  }
}
