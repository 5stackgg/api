import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";

// Deliberately local, and deliberately not an import from src/game-plugins:
// game_modes is uncommitted WIP that is absent on this branch, so everything
// here has to resolve to null rather than fail to resolve.
export type UtilityGameModeRef = {
  id: string;
  slug: string;
};

@Injectable()
export class UtilityPracticeModeService implements OnApplicationBootstrap {
  public static readonly SLUG = "utility-practice";

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

  // Resolved once per process. Every practice match asks for it on the way to
  // its match_options, and the row is installed on boot -- so re-running the
  // upsert per booking would be a write per practice server for an answer that
  // cannot change under us.
  private resolved: UtilityGameModeRef | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.ensureMode();
  }

  public async ensureMode(): Promise<UtilityGameModeRef | null> {
    if (this.resolved) {
      return this.resolved;
    }

    if (!(await this.hasGameModes())) {
      return null;
    }

    try {
      const [mode] = await this.postgres.query<
        Array<{ id: string; slug: string }>
      >(
        // The cfg is installed once and is the operator's afterwards: this runs
        // on every boot, and re-asserting EXCLUDED.cfg would silently undo any
        // cvar they had edited on this mode. competitive_safe is the one thing
        // held down, because a practice mode that claims to be safe would let
        // sv_cheats into a ranked match.
        `INSERT INTO public.game_modes (slug, name, description, competitive_safe, cfg, enabled)
         VALUES ($1, $2, $3, false, $4, true)
         ON CONFLICT (slug) DO UPDATE
            SET competitive_safe = false
         RETURNING id::text AS id, slug`,
        [
          UtilityPracticeModeService.SLUG,
          "Utility Practice",
          "Utility practice. Never competitive-safe, never counts for ELO.",
          UtilityPracticeModeService.CFG.join("\n"),
        ],
      );

      this.resolved = { id: mode.id, slug: mode.slug };

      return this.resolved;
    } catch (error) {
      // The WIP schema is not frozen. A column that has since been renamed must
      // not take the whole API down on boot.
      this.logger.warn(
        `unable to install the utility-practice game mode: ${(error as Error)?.message}`,
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
