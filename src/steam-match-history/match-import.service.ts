import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { ParsedDemo, ParsedPlayer } from "../demos/demo-parser.service";
import { S3Service } from "../s3/s3.service";
import { e_match_types_enum } from "../../generated";

type MatchType = e_match_types_enum;
type Side = "T" | "CT";

type SteamPlayerSummary = {
  steamid: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  loccountrycode?: string;
};

@Injectable()
export class MatchImportService {
  private readonly steamApiKey: string;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.steamApiKey = this.config.get<string>("steam.steamApiKey") ?? "";
  }

  public async importExternalDemo(
    parsed: ParsedDemo,
    source: string,
    sourceKey: string,
    demoUrl?: string,
    matchStartTime?: string | null,
    externalId?: string | null,
    sourceObjectKey?: string,
  ): Promise<{ matchId: string | null; skipped?: string }> {
    let file = demoUrl ?? `external/${source}/${sourceKey}.dem`;

    if (externalId) {
      const existing = await this.findExistingExternalMatch(source, externalId);
      if (existing) {
        return { matchId: existing, skipped: "already imported" };
      }
    } else {
      const existing = await this.findExistingByFile(file);
      if (existing) {
        return { matchId: existing, skipped: "already imported" };
      }
    }

    const players = (parsed.players ?? []).filter(
      (p) => p.steam_id && /^\d+$/.test(p.steam_id),
    );
    if (players.length === 0) {
      return { matchId: null, skipped: "no players in demo" };
    }

    const matchType = MatchImportService.detectMatchType(parsed);
    this.logger.log(
      `match-type detect: type=${matchType} players=${parsed.player_count ?? players.length} overtime=${parsed.overtime_enabled ?? false} faceit=${MatchImportService.isFaceitServer(parsed.server_name)} rankTypes=${[...new Set(players.map((p) => p.rank_type ?? 0))].join(",")}`,
    );
    const mapId = await this.resolveMapId(parsed.map_name, matchType);
    if (!mapId) {
      return {
        matchId: null,
        skipped: `unknown map ${parsed.map_name ?? "<none>"}`,
      };
    }

    const mapPoolId = await this.resolveSeedMapPoolId(matchType);
    if (!mapPoolId) {
      return { matchId: null, skipped: `no seed map pool for ${matchType}` };
    }

    await this.upsertPlayers(players);

    const startingSides = MatchImportService.computeStartingSides(parsed);
    const [lineup1Players, lineup2Players] =
      MatchImportService.splitLineupsBySide(players, startingSides);

    if (lineup1Players.length === 0 || lineup2Players.length === 0) {
      return {
        matchId: null,
        skipped: "could not derive two teams from demo",
      };
    }

    const matchOptionsId = await this.insertMatchOptions(matchType, mapPoolId);
    const lineup1Id = await this.insertLineup("Team 1");
    const lineup2Id = await this.insertLineup("Team 2");

    await this.insertLineupPlayers(lineup1Id, lineup1Players);
    await this.insertLineupPlayers(lineup2Id, lineup2Players);

    let startedAt = matchStartTime ?? null;
    let startSource = startedAt ? "gc-matchtime" : "none";
    if (!startedAt) {
      startedAt = await this.resolveDemoStartTime(demoUrl);
      if (startedAt) {
        startSource = "demo-cdn-last-modified";
      }
    }
    this.logger.log(
      `match date for ${source}/${sourceKey}: ${startedAt ?? "<none — will stamp import time>"} [source=${startSource}]`,
    );

    const matchId = await this.insertMatch({
      source,
      lineup1Id,
      lineup2Id,
      matchOptionsId,
      startedAt,
    });

    if (externalId) {
      await this.postgres.query(
        `UPDATE public.matches SET external_id = $2 WHERE id = $1::uuid`,
        [matchId, externalId],
      );
    }

    let matchMapId: string;
    let demoId: string;
    try {
      matchMapId = await this.insertMatchMap(matchId, mapId, startedAt);

      if (sourceObjectKey) {
        const demoName = sourceObjectKey.replace(/^.*\//, "");
        file = `demos/${matchId}/${matchMapId}/${demoName}`;
        await this.s3.copyObject(sourceObjectKey, file);
      }

      demoId = await this.insertMatchMapDemo(matchId, matchMapId, file);

      // persist_imported_demo writes rounds/kills/stats and the premier rank
      // history + players.premier_rank in one shot, so there is no separate
      // JS premier-rank write here.
      await this.postgres.query(
        `SELECT public.persist_imported_demo($1::uuid, $2::jsonb)`,
        [demoId, JSON.stringify(parsed)],
      );
    } catch (error) {
      // Roll back the half-written match; otherwise findExistingByFile treats
      // it as "already imported" and the retry skips it permanently.
      await this.rollbackMatch(matchId, [lineup1Id, lineup2Id]);
      throw error;
    }

    // Playback blob is supplementary — a failure here must not discard an
    // otherwise complete import.
    try {
      await this.demoMetadata.uploadPlaybackBlob(
        matchId,
        matchMapId,
        demoId,
        parsed,
      );
    } catch (error) {
      this.logger.warn(
        `playback blob upload failed for match ${matchId}: ${(error as Error)?.message ?? String(error)}`,
      );
    }

    this.logger.log(
      `imported ${source} match ${matchId}: ${matchType} on ${parsed.map_name} ` +
        `(${lineup1Players.length}v${lineup2Players.length} players)`,
    );

    return { matchId };
  }

  // Deleting the match cascades to its match_maps/demos/rounds/stats; the
  // freshly-created lineups carry no match_id, so remove them explicitly.
  private async rollbackMatch(
    matchId: string,
    lineupIds: string[],
  ): Promise<void> {
    try {
      await this.postgres.query(
        `DELETE FROM public.matches WHERE id = $1::uuid`,
        [matchId],
      );
      await this.postgres.query(
        `DELETE FROM public.match_lineups WHERE id = ANY($1::uuid[])`,
        [lineupIds],
      );
    } catch (error) {
      this.logger.error(
        `failed to roll back partial import for match ${matchId}`,
        error,
      );
    }
  }

  private static detectMatchType(parsed: ParsedDemo): MatchType {
    const players = parsed.players ?? [];
    const playerCount = parsed.player_count ?? players.length;
    const isWingman = playerCount > 0 && playerCount <= 4;
    // game_mode is Valve's authoritative mode flag (1=Competitive/Premier,
    // 2=Wingman). Wingman and Competitive both stamp rank_type 7 on the
    // 1-18 skill-group scale, so rank_type alone can't tell them apart;
    // mp_maxrounds is 16 for Wingman vs 24 for Competitive/Premier.
    if (parsed.game_mode === 2 || parsed.max_rounds === 16) {
      return "Wingman";
    }

    // rank_type: 6=Wingman, 7/12=Competitive, 11=Premier, 10=private lobby.
    const counts = new Map<number, number>();
    for (const p of players) {
      if (typeof p.rank_type === "number" && p.rank_type > 0) {
        counts.set(p.rank_type, (counts.get(p.rank_type) ?? 0) + 1);
      }
    }
    let observed: number | undefined;
    let best = 0;
    for (const [rankType, count] of counts) {
      if (count > best) {
        best = count;
        observed = rankType;
      }
    }
    if (observed === 11) {
      return "Premier";
    }
    if (observed === 7 || observed === 12) {
      return "Competitive";
    }
    if (observed === 6) {
      return "Wingman";
    }

    // 10 = private lobby (FACEIT/practice): never Premier even with overtime;
    // Premier is exclusively rank_type 11.
    if (observed === 10) {
      return isWingman ? "Wingman" : "Competitive";
    }

    // No rank_type at all — fall back to game rules.
    if (isWingman) {
      return "Wingman";
    }
    if (parsed.overtime_enabled) {
      return "Premier";
    }
    return "Competitive";
  }

  static isFaceitServer(serverName?: string | null): boolean {
    return /faceit/i.test(serverName ?? "");
  }

  private static computeStartingSides(parsed: ParsedDemo): Map<string, Side> {
    const sides = new Map<string, Side>();
    // A player's side must be read from round 1 — sides swap at halftime, so
    // a player's first kill later in the demo can be on the opposite side and
    // would scramble the lineup split.
    const firstRound = (parsed.round_ticks ?? [])
      .filter((r) => r.round > 0)
      .sort((a, b) => a.round - b.round)
      .at(0);
    const allKills = parsed.kills ?? [];
    const kills = firstRound
      ? allKills.filter(
          (k) =>
            k.tick >= firstRound.start_tick && k.tick <= firstRound.end_tick,
        )
      : allKills;
    for (const kill of kills) {
      const killerTeam = MatchImportService.normalizeTeam(kill.killer_team);
      const victimTeam = MatchImportService.normalizeTeam(kill.victim_team);
      if (kill.killer && killerTeam && !sides.has(kill.killer)) {
        sides.set(kill.killer, killerTeam);
      }
      if (kill.victim && victimTeam && !sides.has(kill.victim)) {
        sides.set(kill.victim, victimTeam);
      }
    }
    return sides;
  }

  private static normalizeTeam(team?: string): Side | null {
    if (!team) {
      return null;
    }
    const t = team.toUpperCase();
    if (t === "T" || t === "TERRORIST" || t === "TERRORISTS") {
      return "T";
    }
    if (t === "CT" || t === "COUNTERTERRORIST" || t === "COUNTERTERRORISTS") {
      return "CT";
    }
    return null;
  }

  private static splitLineupsBySide(
    players: ParsedPlayer[],
    sides: Map<string, Side>,
  ): [ParsedPlayer[], ParsedPlayer[]] {
    const t: ParsedPlayer[] = [];
    const ct: ParsedPlayer[] = [];
    const unsided: ParsedPlayer[] = [];
    for (const p of players) {
      const side = sides.get(p.steam_id);
      if (side === "T") {
        t.push(p);
      } else if (side === "CT") {
        ct.push(p);
      } else {
        unsided.push(p);
      }
    }
    for (const p of unsided) {
      if (t.length <= ct.length) {
        t.push(p);
      } else {
        ct.push(p);
      }
    }
    return [t, ct];
  }

  public async findExistingExternalMatch(
    source: string,
    externalId: string,
  ): Promise<string | null> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id
         FROM public.matches
        WHERE source = $1 AND external_id = $2
        LIMIT 1`,
      [source, externalId],
    );
    return rows.at(0)?.id ?? null;
  }

  private async findExistingByFile(file: string): Promise<string | null> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: { where: { file: { _eq: file } }, limit: 1 },
        match_id: true,
      },
    });
    return match_map_demos.at(0)?.match_id ?? null;
  }

  private async resolveMapId(
    mapName: string | undefined,
    matchType: MatchType,
  ): Promise<string | null> {
    if (!mapName) {
      return null;
    }
    // Premier maps live under the Competitive type row in the maps table.
    const lookupType = matchType === "Premier" ? "Competitive" : matchType;
    const { maps } = await this.hasura.query({
      maps: {
        __args: {
          where: { name: { _eq: mapName }, type: { _eq: lookupType } },
          limit: 1,
        },
        id: true,
      },
    });
    const typed = maps.at(0)?.id;
    if (typed) {
      return typed;
    }
    const { maps: anyMaps } = await this.hasura.query({
      maps: {
        __args: { where: { name: { _eq: mapName } }, limit: 1 },
        id: true,
      },
    });
    return anyMaps.at(0)?.id ?? null;
  }

  private async resolveSeedMapPoolId(
    matchType: MatchType,
  ): Promise<string | null> {
    const lookupType = matchType === "Premier" ? "Competitive" : matchType;
    const { map_pools } = await this.hasura.query({
      map_pools: {
        __args: {
          where: {
            type: { _eq: lookupType },
            seed: { _eq: true },
            enabled: { _eq: true },
          },
          limit: 1,
        },
        id: true,
      },
    });
    return map_pools.at(0)?.id ?? null;
  }

  private async upsertPlayers(players: ParsedPlayer[]): Promise<void> {
    if (players.length === 0) {
      return;
    }
    await this.hasura.mutation({
      insert_players: {
        __args: {
          objects: players.map((p) => ({
            steam_id: p.steam_id,
            name: p.name,
          })),
          on_conflict: {
            constraint: "players_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });

    try {
      await this.enrichPlayerProfiles(players.map((p) => p.steam_id));
    } catch (error) {
      this.logger.warn(
        `enrichPlayerProfiles failed: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  }

  private async enrichPlayerProfiles(steamIds: string[]): Promise<void> {
    if (!this.steamApiKey || steamIds.length === 0) {
      return;
    }

    const needs = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE steam_id = ANY($1::bigint[])
          AND (avatar_url IS NULL OR country IS NULL OR profile_url IS NULL)`,
      [steamIds],
    );
    if (needs.length === 0) {
      return;
    }

    const summaries: SteamPlayerSummary[] = [];
    for (let i = 0; i < needs.length; i += 100) {
      const batch = needs.slice(i, i + 100).map((r) => r.steam_id);
      const url = new URL(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      );
      url.searchParams.set("key", this.steamApiKey);
      url.searchParams.set("steamids", batch.join(","));
      const res = await fetch(url.toString());
      if (!res.ok) {
        this.logger.warn(
          `GetPlayerSummaries http ${res.status} for ${batch.length} players`,
        );
        continue;
      }
      const body = (await res.json()) as {
        response?: { players?: SteamPlayerSummary[] };
      };
      summaries.push(...(body.response?.players ?? []));
    }

    if (summaries.length === 0) {
      return;
    }

    const ids: string[] = [];
    const names: string[] = [];
    const avatars: (string | null)[] = [];
    const profiles: (string | null)[] = [];
    const countries: (string | null)[] = [];
    for (const s of summaries) {
      if (!s.steamid) {
        continue;
      }
      ids.push(s.steamid);
      names.push(s.personaname ?? "");
      avatars.push(s.avatarfull ?? null);
      profiles.push(s.profileurl ?? null);
      countries.push(s.loccountrycode ?? null);
    }

    if (ids.length === 0) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.players AS p
          SET name = CASE WHEN p.name IS NULL OR p.name = '' THEN COALESCE(NULLIF(v.name, ''), p.name) ELSE p.name END,
              avatar_url = COALESCE(p.avatar_url, v.avatar_url),
              profile_url = COALESCE(p.profile_url, v.profile_url),
              country = COALESCE(p.country, v.country)
         FROM (
           SELECT UNNEST($1::bigint[]) AS steam_id,
                  UNNEST($2::text[])   AS name,
                  UNNEST($3::text[])   AS avatar_url,
                  UNNEST($4::text[])   AS profile_url,
                  UNNEST($5::text[])   AS country
         ) AS v
        WHERE p.steam_id = v.steam_id`,
      [ids, names, avatars, profiles, countries],
    );
  }

  private async insertMatchOptions(
    matchType: MatchType,
    mapPoolId: string,
  ): Promise<string> {
    const { insert_match_options_one } = await this.hasura.mutation({
      insert_match_options_one: {
        __args: {
          object: {
            type: matchType,
            map_pool_id: mapPoolId,
            best_of: 1,
            mr: matchType === "Wingman" ? 8 : 12,
            overtime: false,
            knife_round: false,
            coaches: false,
            map_veto: false,
            number_of_substitutes: 0,
          },
        },
        id: true,
      },
    });
    return insert_match_options_one.id;
  }

  private async insertLineup(teamName: string): Promise<string> {
    const { insert_match_lineups_one } = await this.hasura.mutation({
      insert_match_lineups_one: {
        __args: {
          object: { team_name: teamName },
        },
        id: true,
      },
    });
    return insert_match_lineups_one.id;
  }

  private async insertLineupPlayers(
    lineupId: string,
    players: ParsedPlayer[],
  ): Promise<void> {
    const objects = players.map((p) => ({
      match_lineup_id: lineupId,
      steam_id: p.steam_id,
    }));
    if (objects.length === 0) {
      return;
    }
    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: { objects },
        __typename: true,
      },
    });
  }

  public async resolveDemoStartTime(demoUrl?: string): Promise<string | null> {
    if (!demoUrl || !/^https?:\/\//i.test(demoUrl)) {
      return null;
    }
    try {
      const res = await fetch(demoUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(15_000),
      });
      const lastModified = res.headers.get("last-modified");
      if (!lastModified) {
        this.logger.warn(
          `demo CDN returned no Last-Modified header for ${demoUrl}`,
        );
        return null;
      }
      const ts = new Date(lastModified);
      if (Number.isNaN(ts.getTime())) {
        this.logger.warn(
          `demo CDN Last-Modified unparseable ("${lastModified}") for ${demoUrl}`,
        );
        return null;
      }
      this.logger.log(
        `demo CDN Last-Modified="${lastModified}" -> ${ts.toISOString()} for ${demoUrl}`,
      );
      return ts.toISOString();
    } catch (error) {
      this.logger.warn(
        `demo timestamp lookup failed for ${demoUrl}: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  private async insertMatch(args: {
    source: string;
    lineup1Id: string;
    lineup2Id: string;
    matchOptionsId: string;
    startedAt: string | null;
  }): Promise<string> {
    const stamp = args.startedAt ?? new Date().toISOString();
    const { insert_matches_one } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            source: args.source,
            status: "Finished",
            lineup_1_id: args.lineup1Id,
            lineup_2_id: args.lineup2Id,
            match_options_id: args.matchOptionsId,
            started_at: stamp,
            ended_at: stamp,
          },
        },
        id: true,
      },
    });
    return insert_matches_one.id;
  }

  private async insertMatchMap(
    matchId: string,
    mapId: string,
    createdAt: string | null,
  ): Promise<string> {
    const object: Record<string, unknown> = {
      match_id: matchId,
      map_id: mapId,
      order: 0,
      status: "Finished",
    };
    if (createdAt) {
      object.created_at = createdAt;
    }
    const { insert_match_maps_one } = await this.hasura.mutation({
      insert_match_maps_one: {
        __args: { object: object as never },
        id: true,
      },
    });
    return insert_match_maps_one.id;
  }

  private async insertMatchMapDemo(
    matchId: string,
    matchMapId: string,
    file: string,
  ): Promise<string> {
    const { insert_match_map_demos_one } = await this.hasura.mutation({
      insert_match_map_demos_one: {
        __args: {
          object: {
            match_id: matchId,
            match_map_id: matchMapId,
            file,
          },
        },
        id: true,
      },
    });
    return insert_match_map_demos_one.id;
  }
}
