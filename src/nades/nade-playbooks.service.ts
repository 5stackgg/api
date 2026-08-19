import { Injectable } from "@nestjs/common";
import { PoolClient } from "pg";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { NadeLibraryRow, NadeLineupsService } from "./nade-lineups.service";

export type NadePlaybookStepInput = {
  nade_lineup_id?: string;
  offset_ms?: number;
  assigned_steam_id?: string | null;
  note?: string | null;
};

export type SaveNadePlaybookInput = {
  playbook_id?: string | null;
  name: string;
  description?: string | null;
  map_name: string;
  side: string;
  team_id?: string | null;
  visibility?: string;
  // Undefined leaves the steps alone (a rename is not a rewrite); an empty
  // array is an explicit "this book has no steps yet".
  steps?: Array<NadePlaybookStepInput>;
};

export type NadePlaybookStep = {
  step_order: number;
  offset_ms: number;
  nade_lineup_id: string;
  assigned_steam_id: string | null;
  note: string | null;
  lineup: NadeLibraryRow;
};

export type NadePlaybookPayload = {
  id: string;
  name: string;
  map_name: string;
  side: string;
  steps: Array<NadePlaybookStep>;
};

type NormalizedStep = {
  nade_lineup_id: string;
  offset_ms: number;
  assigned_steam_id: string | null;
  note: string | null;
};

@Injectable()
export class NadePlaybooksService {
  // Five players with a couple of throws each. Past this it is not an execute,
  // it is a way to make the plugin's countdown timer allocate forever.
  public static readonly MAX_STEPS = 32;
  public static readonly MAX_OFFSET_MS = 600000;

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(private readonly postgres: PostgresService) {}

  public async save(
    user: User,
    input: SaveNadePlaybookInput,
  ): Promise<{ id: string }> {
    const name = NadeLineupsService.sanitizeName(input.name, "Playbook");
    const description = NadeLineupsService.sanitizeText(
      input.description,
      1000,
    );
    const visibility = input.visibility ?? "Private";
    // A client that always sends every variable sends null for the steps it
    // is not touching, and that has to mean the same as leaving them out --
    // "clear the book" is an empty array.
    const steps =
      input.steps === undefined || input.steps === null
        ? null
        : NadePlaybooksService.normalizeSteps(input.steps);

    return await this.postgres.transaction(async (client) => {
      let playbookId = input.playbook_id ?? null;

      if (playbookId) {
        if (!NadePlaybooksService.UUID.test(playbookId)) {
          throw Error("playbook not found");
        }

        const {
          rows: [existing],
        } = await client.query<{ editable: boolean }>(
          `SELECT public.can_edit_nade_playbook(p, $2::json) AS editable
             FROM public.nade_playbooks p WHERE p.id = $1::uuid`,
          [playbookId, this.sessionJson(user)],
        );

        if (!existing) {
          throw Error("playbook not found");
        }

        if (!existing.editable) {
          throw Error("you cannot edit that playbook");
        }

        // Steps go first: tbiu_nade_playbooks refuses to move a written book
        // to another map, and a rewrite legitimately does both at once.
        if (steps) {
          await client.query(
            "DELETE FROM public.nade_playbook_steps WHERE playbook_id = $1::uuid",
            [playbookId],
          );
        }

        await client.query(
          `UPDATE public.nade_playbooks
              SET name = $2,
                  description = $3,
                  map_name = $4,
                  side = $5,
                  team_id = $6::uuid,
                  visibility = $7
            WHERE id = $1::uuid`,
          [
            playbookId,
            name,
            description,
            input.map_name,
            input.side,
            input.team_id ?? null,
            visibility,
          ],
        );
      } else {
        const {
          rows: [created],
        } = await client.query<{ id: string }>(
          `INSERT INTO public.nade_playbooks
             (name, description, map_name, side, team_id, owner_steam_id, visibility)
           VALUES ($1, $2, $3, $4, $5::uuid, $6::bigint, $7)
           RETURNING id::text AS id`,
          [
            name,
            description,
            input.map_name,
            input.side,
            input.team_id ?? null,
            user.steam_id,
            visibility,
          ],
        );

        playbookId = created.id;
      }

      if (steps) {
        await this.insertSteps(client, user, playbookId, steps);
      }

      return { id: playbookId };
    });
  }

  public async remove(
    user: User,
    playbookId: string,
  ): Promise<{ success: boolean }> {
    if (!NadePlaybooksService.UUID.test(String(playbookId ?? ""))) {
      throw Error("playbook not found");
    }

    const [row] = await this.postgres.query<Array<{ editable: boolean }>>(
      `SELECT public.can_edit_nade_playbook(p, $2::json) AS editable
         FROM public.nade_playbooks p WHERE p.id = $1::uuid`,
      [playbookId, this.sessionJson(user)],
    );

    if (!row) {
      throw Error("playbook not found");
    }

    if (!row.editable) {
      throw Error("you cannot edit that playbook");
    }

    // Steps cascade; any session running this book has its playbook_id set to
    // null by the FK, which the plugin reads as "no execute loaded".
    await this.postgres.query(
      "DELETE FROM public.nade_playbooks WHERE id = $1::uuid",
      [playbookId],
    );

    return { success: true };
  }

  public async viewable(
    user: User,
    playbookId: string,
  ): Promise<{ id: string; map_name: string }> {
    if (!NadePlaybooksService.UUID.test(String(playbookId ?? ""))) {
      throw Error("playbook not found");
    }

    const [row] = await this.postgres.query<
      Array<{ id: string; map_name: string; visible: boolean }>
    >(
      `SELECT p.id::text AS id, p.map_name,
              public.can_view_nade_playbook(p, $2::json) AS visible
         FROM public.nade_playbooks p WHERE p.id = $1::uuid`,
      [playbookId, this.sessionJson(user)],
    );

    if (!row || !row.visible) {
      throw Error("playbook not found");
    }

    return { id: row.id, map_name: row.map_name };
  }

  public async forSession(
    sessionId: string,
  ): Promise<NadePlaybookPayload | null> {
    const [playbook] = await this.postgres.query<
      Array<{ id: string; name: string; map_name: string; side: string }>
    >(
      `SELECT p.id::text AS id, p.name, p.map_name, p.side
         FROM public.nade_practice_sessions s
         INNER JOIN public.nade_playbooks p ON p.id = s.playbook_id
        WHERE s.id = $1::uuid`,
      [sessionId],
    );

    if (!playbook) {
      return null;
    }

    return { ...playbook, steps: await this.steps(playbook.id) };
  }

  public async steps(playbookId: string): Promise<Array<NadePlaybookStep>> {
    const rows = await this.postgres.query<
      Array<
        NadeLibraryRow & {
          step_order: number;
          offset_ms: number;
          nade_lineup_id: string;
          assigned_steam_id: string | null;
          note: string | null;
        }
      >
    >(
      `SELECT st.step_order, st.offset_ms,
              st.nade_lineup_id::text AS nade_lineup_id,
              st.assigned_steam_id::text AS assigned_steam_id,
              st.note,
              l.id::text AS id, l.name, l.map_name, l.nade_type, l.side,
              l.technique, l.throw_strength, l.jump_throw_bind,
              l.origin_x, l.origin_y, l.origin_z, l.eye_z,
              l.view_yaw, l.view_pitch, l.land_x, l.land_y, l.land_z,
              l.initial_pos_x, l.initial_pos_y, l.initial_pos_z,
              l.initial_vel_x, l.initial_vel_y, l.initial_vel_z,
              l.flight_time_ms, l.visibility, l.confidence,
              l.author_steam_id::text AS author_steam_id
         FROM public.nade_playbook_steps st
         INNER JOIN public.nade_lineups l ON l.id = st.nade_lineup_id
        WHERE st.playbook_id = $1::uuid
        ORDER BY st.step_order ASC`,
      [playbookId],
    );

    return rows.map((row) => {
      const {
        step_order,
        offset_ms,
        nade_lineup_id,
        assigned_steam_id,
        note,
        ...lineup
      } = row;

      return {
        step_order,
        offset_ms,
        nade_lineup_id,
        assigned_steam_id,
        note,
        lineup,
      };
    });
  }

  // The geometry a step points at is never taken on trust: a step is a
  // reference to somebody's lineup, and a book must not become a way to read a
  // lineup its author kept private.
  private async insertSteps(
    client: PoolClient,
    user: User,
    playbookId: string,
    steps: Array<NormalizedStep>,
  ): Promise<void> {
    if (steps.length === 0) {
      return;
    }

    const { rows: lineups } = await client.query<{
      id: string;
      map_name: string;
      visible: boolean;
    }>(
      `SELECT l.id::text AS id, l.map_name,
              public.can_view_nade_lineup(l, $2::json) AS visible
         FROM public.nade_lineups l
        WHERE l.id = ANY($1::uuid[])`,
      [steps.map((step) => step.nade_lineup_id), this.sessionJson(user)],
    );

    const {
      rows: [playbook],
    } = await client.query<{ map_name: string }>(
      "SELECT map_name FROM public.nade_playbooks WHERE id = $1::uuid",
      [playbookId],
    );

    for (const step of steps) {
      const lineup = lineups.find((row) => row.id === step.nade_lineup_id);

      if (!lineup || !lineup.visible) {
        throw Error("one of those lineups does not exist");
      }

      if (lineup.map_name !== playbook.map_name) {
        throw Error("one of those lineups is on another map");
      }
    }

    const assigned = steps
      .map((step) => step.assigned_steam_id)
      .filter((steamId): steamId is string => steamId !== null);

    if (assigned.length > 0) {
      const { rows: players } = await client.query<{ steam_id: string }>(
        "SELECT steam_id::text AS steam_id FROM public.players WHERE steam_id = ANY($1::bigint[])",
        [assigned],
      );

      for (const steamId of assigned) {
        if (!players.some((player) => player.steam_id === steamId)) {
          throw Error("one of those players is unknown");
        }
      }
    }

    for (const [index, step] of steps.entries()) {
      await client.query(
        `INSERT INTO public.nade_playbook_steps
           (playbook_id, nade_lineup_id, step_order, offset_ms, assigned_steam_id, note)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5::bigint, $6)`,
        [
          playbookId,
          step.nade_lineup_id,
          index,
          step.offset_ms,
          step.assigned_steam_id,
          step.note,
        ],
      );
    }
  }

  private sessionJson(user: User): string {
    return JSON.stringify({
      "x-hasura-role": user.role,
      "x-hasura-user-id": user.steam_id,
    });
  }

  private static normalizeSteps(
    steps: Array<NadePlaybookStepInput>,
  ): Array<NormalizedStep> {
    if (!Array.isArray(steps)) {
      throw Error("steps is not an array");
    }

    if (steps.length > NadePlaybooksService.MAX_STEPS) {
      throw Error("that playbook has too many steps");
    }

    return steps.map((step) => {
      const lineupId = String(step?.nade_lineup_id ?? "");

      if (!NadePlaybooksService.UUID.test(lineupId)) {
        throw Error("a step is missing its lineup");
      }

      const offset = Number(step?.offset_ms ?? 0);

      if (
        !Number.isFinite(offset) ||
        offset < 0 ||
        offset > NadePlaybooksService.MAX_OFFSET_MS
      ) {
        throw Error("a step is thrown outside the execute");
      }

      const assigned =
        step?.assigned_steam_id === null ||
        step?.assigned_steam_id === undefined
          ? null
          : String(step.assigned_steam_id);

      if (assigned !== null && !/^\d{5,20}$/.test(assigned)) {
        throw Error("a step is assigned to something that is not a steam id");
      }

      return {
        nade_lineup_id: lineupId,
        offset_ms: Math.round(offset),
        assigned_steam_id: assigned,
        note: NadeLineupsService.sanitizeText(step?.note, 200),
      };
    });
  }
}
