import { Injectable } from "@nestjs/common";
import { e_player_roles_enum } from "generated";
import { PostgresService } from "src/postgres/postgres.service";

@Injectable()
export class PlayerBlocksService {
  constructor(private readonly postgres: PostgresService) {}

  public async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ blocked: boolean }>>(
      "SELECT public.is_blocked_either_way($1::bigint, $2::bigint) AS blocked",
      [a, b],
    );

    return row?.blocked === true;
  }

  public async hasBlocked(blocker: string, blocked: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ blocked: boolean }>>(
      "SELECT public.has_blocked_player($1::bigint, $2::bigint) AS blocked",
      [blocker, blocked],
    );

    return row?.blocked === true;
  }

  // Who `viewer` blocked -- never the reverse, which would expose who blocked
  // them. A viewer whose current role is in `exemptRoles` has nothing hidden.
  public async blockedBy(
    viewer: string,
    exemptRoles: Array<e_player_roles_enum> = [],
  ): Promise<Set<string>> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT pb.blocked_steam_id::text AS steam_id
         FROM public.player_blocks pb
         JOIN public.players p ON p.steam_id = pb.blocker_steam_id
        WHERE pb.blocker_steam_id = $1::bigint
          AND p.role::text <> ALL($2::text[])`,
      [viewer, exemptRoles],
    );

    return new Set(rows.map((row) => row.steam_id));
  }

  // Server-side filtering only: it says who blocked whom, so never hand it to
  // a client.
  public async blockedAmong(
    viewers: Array<string>,
    authors: Array<string>,
    exemptRoles: Array<e_player_roles_enum> = [],
  ): Promise<Map<string, Set<string>>> {
    const blocked = new Map<string, Set<string>>();

    if (viewers.length === 0 || authors.length === 0) {
      return blocked;
    }

    const rows = await this.postgres.query<
      Array<{ viewer: string; author: string }>
    >(
      `SELECT pb.blocker_steam_id::text AS viewer,
              pb.blocked_steam_id::text AS author
         FROM public.player_blocks pb
         JOIN public.players p ON p.steam_id = pb.blocker_steam_id
        WHERE pb.blocker_steam_id = ANY($1::bigint[])
          AND pb.blocked_steam_id = ANY($2::bigint[])
          AND p.role::text <> ALL($3::text[])`,
      [viewers, authors, exemptRoles],
    );

    for (const { viewer, author } of rows) {
      if (!blocked.has(viewer)) {
        blocked.set(viewer, new Set());
      }

      blocked.get(viewer).add(author);
    }

    return blocked;
  }

  public async filterUnblocked(
    actor: string,
    candidates: Array<string>,
  ): Promise<Array<string>> {
    if (candidates.length === 0) {
      return [];
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT candidate.steam_id::text AS steam_id
         FROM unnest($2::bigint[]) WITH ORDINALITY AS candidate(steam_id, position)
        WHERE NOT public.is_blocked_either_way($1::bigint, candidate.steam_id)
        ORDER BY candidate.position`,
      [actor, candidates],
    );

    return rows.map((row) => row.steam_id);
  }
}
