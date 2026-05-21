import { Controller, Get, Logger, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../../hasura/hasura.service";
import { AppConfig } from "src/configs/types/AppConfig";

// Cluster-internal — do not add /hud-data to the public api ingress without
// adding auth first (leaks player names + steam ids).
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
        options: { best_of: true },
        match_maps: {
          __args: { order_by: [{ order: "asc" }] },
          id: true,
          order: true,
          status: true,
          lineup_1_score: true,
          lineup_2_score: true,
          winning_lineup_id: true,
          map: { name: true },
          vetos: {
            type: true,
            match_lineup_id: true,
            side: true,
          },
        },
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
        const teamScoped =
          (teamId &&
            p?.team_members?.find((tm) => tm.team_id === teamId)
              ?.roster_image_url) ||
          null;
        const raw = teamScoped ?? p?.roster_image_url ?? null;
        const avatar = absolutize(raw ?? "");
        const playerName = p?.name || lp.placeholder_name || "Player";
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
        best_of: match.options?.best_of ?? 1,
        lineup_1_id: match.lineup_1?.id ?? null,
        lineup_2_id: match.lineup_2?.id ?? null,
        lineups: [
          lineupToHudShape(match.lineup_1),
          lineupToHudShape(match.lineup_2),
        ].filter((l): l is NonNullable<typeof l> => l !== null),
        match_maps: (match.match_maps ?? []).map((mm) => {
          const mapPick = (mm.vetos ?? []).find(
            (v) => v.type === "Pick" || v.type === "Decider",
          );
          return {
            id: mm.id,
            order: mm.order,
            status: mm.status,
            map_name: mm.map?.name ?? "",
            lineup_1_score: mm.lineup_1_score ?? 0,
            lineup_2_score: mm.lineup_2_score ?? 0,
            winning_lineup_id: mm.winning_lineup_id ?? null,
            picked_by_lineup_id: mapPick?.match_lineup_id ?? null,
            pick_type: mapPick?.type ?? "Decider",
          };
        }),
      },
    };

    response.status(200).json(payload);
  }
}
