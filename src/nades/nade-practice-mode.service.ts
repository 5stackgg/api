import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";

// Deliberately local, and deliberately not an import from src/game-plugins:
// game_modes is uncommitted WIP that is absent on this branch, so everything
// here has to resolve to null rather than fail to resolve.
export type NadeGameModeRef = {
  id: string;
  slug: string;
};

@Injectable()
export class NadePracticeModeService implements OnApplicationBootstrap {
  public static readonly SLUG = "nade-practice";

  // mp_ignore_round_win_conditions is what keeps the round from ever ending:
  // without it the first kill or expired timer resets everyone's setup
  // mid-lineup. tv_enable 0 because a practice session produces no demo anybody
  // wants.
  private static readonly CFG: ReadonlyArray<string> = [
    "sv_cheats 1",
    "mp_ignore_round_win_conditions 1",
    "mp_warmup_end",
    "mp_freezetime 0",
    "mp_roundtime 60",
    "mp_roundtime_defuse 60",
    "mp_respawn_immunitytime 0",
    "mp_buy_anywhere 1",
    "mp_buytime 60000",
    "mp_maxmoney 65535",
    "mp_startmoney 65535",
    "mp_afterroundmoney 65535",
    "mp_death_drop_gun 0",
    "mp_death_drop_grenade 0",
    "mp_solid_teammates 0",
    "mp_teammates_are_enemies 0",
    "sv_grenade_trajectory_prac_pipreview 1",
    "sv_infinite_ammo 1",
    "ammo_grenade_limit_total 5",
    "sv_full_alltalk 1",
    "tv_enable 0",
  ];

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.ensureMode();
  }

  public async ensureMode(): Promise<NadeGameModeRef | null> {
    if (!(await this.hasGameModes())) {
      return null;
    }

    try {
      const [mode] = await this.postgres.query<
        Array<{ id: string; slug: string }>
      >(
        `INSERT INTO public.game_modes (slug, name, description, competitive_safe, cfg, enabled)
         VALUES ($1, $2, $3, false, $4, true)
         ON CONFLICT (slug) DO UPDATE
            SET name = EXCLUDED.name,
                description = EXCLUDED.description,
                competitive_safe = false,
                cfg = EXCLUDED.cfg
         RETURNING id::text AS id, slug`,
        [
          NadePracticeModeService.SLUG,
          "Nade Practice",
          "Utility practice. Never competitive-safe, never counts for ELO.",
          NadePracticeModeService.CFG.join("\n"),
        ],
      );

      return { id: mode.id, slug: mode.slug };
    } catch (error) {
      // The WIP schema is not frozen. A column that has since been renamed must
      // not take the whole API down on boot.
      this.logger.warn(
        `unable to install the nade-practice game mode: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  private async hasGameModes(): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ present: boolean }>>(
      "SELECT to_regclass('public.game_modes') IS NOT NULL AS present",
    );
    return row?.present === true;
  }
}
