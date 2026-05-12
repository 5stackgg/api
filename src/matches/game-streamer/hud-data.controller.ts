import { Controller, Get, Logger, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../../hasura/hasura.service";
import { AppConfig } from "src/configs/types/AppConfig";

/**
 * Cluster-internal endpoint used by the in-pod HUD seeder
 * (game-streamer/src/lib/hud-manager.sh -> seed_hud_db) to fetch a
 * pre-flattened match shape — lineup metadata with absolute avatar/logo
 * URLs — for posting onward to JT's HUD Manager REST API.
 *
 * Mounted at /hud-data/:matchId (NOT under /matches) so it is excluded
 * from the public api ingress, which only exposes specific prefixes.
 * If you add this controller's base path to k8s/ingress, you'll be
 * leaking player names + steam ids to the open internet — gate it
 * with auth first.
 */
@Controller("hud-data")
export class HudDataController {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  @Get(":matchId")
  public async getMatchHudData(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const matchId = request.params.matchId;
    const apiDomain = (this.appConfig.apiDomain || "").replace(/\/$/, "");

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        lineup_1: {
          id: true,
          name: true,
          team: { id: true, name: true, short_name: true, avatar_url: true },
          lineup_players: {
            steam_id: true,
            placeholder_name: true,
            player: {
              name: true,
              country: true,
              avatar_url: true,
              custom_avatar_url: true,
              roster_image_url: true,
              team_members: { team_id: true, roster_image_url: true },
            },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          team: { id: true, name: true, short_name: true, avatar_url: true },
          lineup_players: {
            steam_id: true,
            placeholder_name: true,
            player: {
              name: true,
              country: true,
              avatar_url: true,
              custom_avatar_url: true,
              roster_image_url: true,
              team_members: { team_id: true, roster_image_url: true },
            },
          },
        },
      },
    });

    if (!match) {
      response.status(404).json({ error: "match not found" });
      return;
    }

    const absolutize = (url?: string | null): string => {
      if (!url) return "";
      if (/^(https?:|data:)/.test(url)) return url;
      if (!apiDomain) return url;
      return apiDomain + (url.startsWith("/") ? "" : "/") + url;
    };

    type LineupShape = NonNullable<typeof match.lineup_1>;
    const lineupToHudShape = (lu: LineupShape | null) => {
      if (!lu) return null;
      const team = lu.team ?? null;
      const teamId = team?.id ?? null;
      const players = (lu.lineup_players ?? []).map((lp) => {
        const p = lp.player;
        this.logger.debug?.(
          `[hud-data ${matchId}] raw player ${lp.steam_id}: ` +
            `name=${p?.name ?? lp.placeholder_name ?? "?"} ` +
            `team_id_for_match=${teamId ?? "<none>"} ` +
            `roster_image_url=${p?.roster_image_url ?? "<null>"} ` +
            `custom_avatar_url=${p?.custom_avatar_url ?? "<null>"} ` +
            `avatar_url=${p?.avatar_url ?? "<null>"} ` +
            `team_members=${JSON.stringify(p?.team_members ?? [])}`,
        );
        const teamScoped =
          (teamId &&
            p?.team_members?.find((tm) => tm.team_id === teamId)
              ?.roster_image_url) ||
          null;
        let source: "team_roster" | "player_roster" | "none";
        let raw: string | null;
        if (teamScoped) {
          source = "team_roster";
          raw = teamScoped;
        } else if (p?.roster_image_url) {
          source = "player_roster";
          raw = p.roster_image_url;
        } else {
          source = "none";
          raw = null;
        }
        const avatar = absolutize(raw ?? "");
        const playerName = p?.name || lp.placeholder_name || "Player";
        this.logger.log(
          `[hud-data ${matchId}] player ${playerName} (${lp.steam_id}) ` +
            `team_id=${teamId ?? "<none>"} ` +
            `avatar_source=${source} url=${avatar || "<empty>"}`,
        );
        return {
          steam_id: lp.steam_id,
          name: playerName,
          country: p?.country || "us",
          avatar,
        };
      });
      return {
        name: team?.name || lu.name || "Team",
        short_name: team?.short_name || "",
        logo: absolutize(team?.avatar_url),
        players,
      };
    };

    const payload = {
      match: {
        id: match.id,
        lineups: [
          lineupToHudShape(match.lineup_1),
          lineupToHudShape(match.lineup_2),
        ].filter((l): l is NonNullable<typeof l> => l !== null),
      },
    };

    response.status(200).json(payload);
  }
}
