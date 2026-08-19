import crypto from "crypto";
import { Readable } from "stream";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../auth/types/User";

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const AWARD_TIERS = ["mvp", "gold", "silver", "bronze", "special"];

export interface AwardRow {
  id: string;
  name: string;
  description: string | null;
  tier: string;
  silhouette: number | null;
  image_url: string | null;
  system_key: string | null;
  allow_multiple: boolean;
  tournament_id: string | null;
  event_id: string | null;
  season_id: string | null;
  league_season_id: string | null;
  created_by_steam_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrantAwardInput {
  award_id: string;
  player_steam_id?: string | null;
  team_id?: string | null;
  tournament_id?: string | null;
  event_id?: string | null;
  season_id?: string | null;
  league_season_id?: string | null;
  note?: string | null;
  awarded_by_steam_id: string;
}

interface TournamentAwardRow {
  id: string;
  tournament_id: string;
  placement: number;
  award_id: string | null;
  custom_name: string | null;
  silhouette: number | null;
  image_url: string | null;
}

@Injectable()
export class AwardsService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {}

  public async listAwards(): Promise<AwardRow[]> {
    return await this.postgres.query<AwardRow[]>(
      `SELECT * FROM public.awards ORDER BY system_key NULLS LAST, name ASC`,
    );
  }

  public async saveAward(
    input: {
      id?: string | null;
      name: string;
      description?: string | null;
      tier: string;
      silhouette?: number | null;
      allow_multiple?: boolean | null;
      tournament_id?: string | null;
      event_id?: string | null;
      season_id?: string | null;
      league_season_id?: string | null;
    },
    steamId: string,
  ): Promise<AwardRow> {
    if (!AWARD_TIERS.includes(input.tier)) {
      throw new BadRequestException("Invalid award tier");
    }
    if (!input.name?.trim()) {
      throw new BadRequestException("Award name is required");
    }
    if (!this.isValidSilhouette(input.silhouette)) {
      throw new BadRequestException("Invalid silhouette");
    }

    this.assertSingleScope(input);

    if (!input.id) {
      const [created] = await this.postgres.query<AwardRow[]>(
        `INSERT INTO public.awards
            (name, description, tier, silhouette, allow_multiple,
             created_by_steam_id, tournament_id, event_id, season_id,
             league_season_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *`,
        [
          input.name.trim(),
          input.description ?? null,
          input.tier,
          input.silhouette ?? null,
          input.allow_multiple ?? false,
          steamId,
          input.tournament_id ?? null,
          input.event_id ?? null,
          input.season_id ?? null,
          input.league_season_id ?? null,
        ],
      );
      return created;
    }

    const [updated] = await this.postgres.query<AwardRow[]>(
      `UPDATE public.awards
          SET name = $2,
              description = $3,
              tier = $4,
              silhouette = $5,
              allow_multiple = $6,
              tournament_id = $7,
              event_id = $8,
              season_id = $9,
              league_season_id = $10,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        input.id,
        input.name.trim(),
        input.description ?? null,
        input.tier,
        input.silhouette ?? null,
        input.allow_multiple ?? false,
        input.tournament_id ?? null,
        input.event_id ?? null,
        input.season_id ?? null,
        input.league_season_id ?? null,
      ],
    );

    if (!updated) {
      throw new NotFoundException("Award not found");
    }

    return updated;
  }

  public async deleteAward(awardId: string): Promise<void> {
    const award = await this.requireAward(awardId);

    if (award.system_key) {
      throw new ForbiddenException(
        "Built-in tournament awards cannot be deleted",
      );
    }

    if (award.image_url) {
      await this.s3.remove(award.image_url);
    }

    await this.postgres.query(`DELETE FROM public.awards WHERE id = $1`, [
      awardId,
    ]);
  }

  public async grantAward(input: GrantAwardInput) {
    const hasPlayer = !!input.player_steam_id;
    const hasTeam = !!input.team_id;

    if (hasPlayer === hasTeam) {
      throw new BadRequestException(
        "An award goes to exactly one player or one team",
      );
    }

    this.assertSingleScope(input);

    await this.requireAward(input.award_id);

    let tournamentTeamId: string | null = null;
    if (input.tournament_id) {
      tournamentTeamId = await this.resolveTournamentTeam(
        input.tournament_id,
        input.player_steam_id ?? null,
        input.team_id ?? null,
      );
    }

    const [granted] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.award_recipients
          (award_id, player_steam_id, team_id, tournament_id, tournament_team_id,
           event_id, season_id, league_season_id,
           source, awarded_by_steam_id, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9, $10)
        RETURNING *`,
      [
        input.award_id,
        input.player_steam_id ?? null,
        input.team_id ?? null,
        input.tournament_id ?? null,
        tournamentTeamId,
        input.event_id ?? null,
        input.season_id ?? null,
        input.league_season_id ?? null,
        input.awarded_by_steam_id,
        input.note ?? null,
      ],
    );

    if (input.team_id) {
      // grantToRoster inserts the roster in one statement rather than looping
      // back through here, so a team grant has to be notified from its own
      // returned rows.
      const roster = await this.grantToRoster(input, tournamentTeamId);

      void this.notifyAwarded(
        roster.map((recipient) => recipient.player_steam_id),
        input.award_id,
        granted.id,
      );
    }

    if (input.player_steam_id) {
      void this.notifyAwarded(
        [input.player_steam_id],
        input.award_id,
        granted.id,
      );
    }

    return granted;
  }

  // The whole roster in one call: the only per-recipient part of this message
  // is who receives it, so the grant is looked up once and notifyPlayers is
  // handed every steam id rather than being called per player.
  private async notifyAwarded(
    steamIds: string[],
    awardId: string,
    recipientId: string,
  ) {
    if (steamIds.length === 0) {
      return;
    }

    try {
      const [award] = await this.postgres.query<
        Array<{ name: string; image_url: string | null }>
      >(`SELECT name, image_url FROM public.awards WHERE id = $1::uuid`, [
        awardId,
      ]);

      await this.notifications.notifyPlayers("AwardGranted", {
        title: "Award Received",
        message: `You were awarded <b>${NotificationsService.escapeHtml(
          award?.name ?? "an award",
        )}</b>.`,
        role: "user",
        entity_id: recipientId,
        steamIds,
        data: { image: AwardsService.imagePath(award?.image_url) },
      });
    } catch (error) {
      this.logger.warn(
        `unable to notify ${steamIds.join(", ")} of award ${awardId}`,
        error,
      );
    }
  }

  public assertSingleScope(input: {
    tournament_id?: string | null;
    event_id?: string | null;
    season_id?: string | null;
    league_season_id?: string | null;
  }): void {
    const scopes = [
      input.tournament_id,
      input.event_id,
      input.season_id,
      input.league_season_id,
    ].filter(Boolean);

    if (scopes.length > 1) {
      throw new BadRequestException("An award belongs to one scope at most");
    }
  }

  public async getRecipient(recipientId: string) {
    const [recipient] = await this.postgres.query<
      Array<{
        id: string;
        source: string;
        tournament_id: string | null;
        event_id: string | null;
        season_id: string | null;
        league_season_id: string | null;
      }>
    >(
      `SELECT id, source, tournament_id, event_id, season_id, league_season_id
         FROM public.award_recipients
        WHERE id = $1
        LIMIT 1`,
      [recipientId],
    );

    if (!recipient) {
      throw new NotFoundException("Award grant not found");
    }

    return recipient;
  }

  public async revokeAward(recipientId: string): Promise<void> {
    const recipient = await this.getRecipient(recipientId);

    if (recipient.source === "tournament") {
      throw new ForbiddenException(
        "Calculated tournament awards are managed by the tournament",
      );
    }

    await this.postgres.query(
      `DELETE FROM public.award_recipients WHERE id = $1`,
      [recipientId],
    );
  }

  public async setTournamentAward(input: {
    tournament_id: string;
    placement: number;
    award_id?: string | null;
    custom_name?: string | null;
    silhouette?: number | null;
  }): Promise<TournamentAwardRow> {
    if (!this.isValidPlacement(input.placement)) {
      throw new BadRequestException("Invalid placement");
    }
    if (!this.isValidSilhouette(input.silhouette)) {
      throw new BadRequestException("Invalid silhouette");
    }
    if (input.award_id) {
      await this.requireAward(input.award_id);
    }

    const [config] = await this.postgres.query<TournamentAwardRow[]>(
      `INSERT INTO public.tournament_awards
          (tournament_id, placement, award_id, custom_name, silhouette)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tournament_id, placement) DO UPDATE
          SET award_id = EXCLUDED.award_id,
              custom_name = EXCLUDED.custom_name,
              silhouette = EXCLUDED.silhouette,
              updated_at = now()
        RETURNING *`,
      [
        input.tournament_id,
        String(input.placement),
        input.award_id ?? null,
        input.custom_name ?? null,
        input.silhouette ?? null,
      ],
    );

    return config;
  }

  public async uploadAwardImage(
    awardId: string,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const award = await this.requireAward(awardId);
    const path = this.buildPath(awardId, mimetype);

    await this.s3.put(path, buffer);

    if (award.image_url && award.image_url !== path) {
      await this.s3.remove(award.image_url);
    }

    await this.postgres.query(
      `UPDATE public.awards SET image_url = $1, updated_at = now() WHERE id = $2`,
      [path, awardId],
    );

    this.logger.log(`Uploaded award ${awardId} image to ${path}`);
    return path;
  }

  public async removeAwardImage(awardId: string): Promise<void> {
    const award = await this.requireAward(awardId);
    if (!award.image_url) {
      return;
    }

    await this.s3.remove(award.image_url);
    await this.postgres.query(
      `UPDATE public.awards SET image_url = NULL, updated_at = now() WHERE id = $1`,
      [awardId],
    );
  }

  public async uploadTournamentAwardImage(
    tournamentId: string,
    placement: number,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (!this.isValidPlacement(placement)) {
      throw new BadRequestException("Invalid placement");
    }

    const existing = await this.getTournamentAward(tournamentId, placement);
    const path = this.buildPath(`${tournamentId}-${placement}`, mimetype);

    await this.s3.put(path, buffer);

    if (existing?.image_url && existing.image_url !== path) {
      await this.s3.remove(existing.image_url);
    }

    if (existing) {
      await this.postgres.query(
        `UPDATE public.tournament_awards
            SET image_url = $1, updated_at = now()
          WHERE id = $2`,
        [path, existing.id],
      );
    } else {
      await this.postgres.query(
        `INSERT INTO public.tournament_awards
            (tournament_id, placement, image_url)
          VALUES ($1, $2, $3)`,
        [tournamentId, String(placement), path],
      );
    }

    this.logger.log(
      `Uploaded tournament ${tournamentId} placement ${placement} award image to ${path}`,
    );
    return path;
  }

  public async removeTournamentAwardImage(
    tournamentId: string,
    placement: number,
  ): Promise<void> {
    if (!this.isValidPlacement(placement)) {
      throw new BadRequestException("Invalid placement");
    }

    const existing = await this.getTournamentAward(tournamentId, placement);
    if (!existing) {
      return;
    }

    if (existing.image_url) {
      await this.s3.remove(existing.image_url);
    }

    await this.postgres.query(
      `UPDATE public.tournament_awards
          SET image_url = NULL, updated_at = now()
        WHERE id = $1`,
      [existing.id],
    );
  }

  public async getStream(
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    // Images uploaded before the awards rename still live under `trophies/`:
    // the migration renamed tables in place, so image_url keeps those keys
    // verbatim. Callers pass a bare filename, so try both prefixes.
    let key = `awards/${filename}`;

    if (!(await this.s3.has(key))) {
      key = `trophies/${filename}`;
      if (!(await this.s3.has(key))) {
        return null;
      }
    }

    const [stream, stat] = await Promise.all([
      this.s3.get(key),
      this.s3.stat(key),
    ]);

    return {
      stream,
      contentType:
        stat.metaData?.["content-type"] || this.guessContentType(filename),
      etag: stat.etag,
    };
  }

  public async requireOrganizer(
    tournamentId: string,
    user: User,
  ): Promise<void> {
    const rows = await this.postgres.query<
      Array<{ organizer_steam_id: string | null }>
    >(
      `SELECT organizer_steam_id
         FROM public.tournaments
        WHERE id = $1
        LIMIT 1`,
      [tournamentId],
    );

    if (!rows || rows.length === 0) {
      throw new ForbiddenException("Tournament not found");
    }

    const isOrganizer =
      String(rows[0].organizer_steam_id) === String(user.steam_id);

    if (isOrganizer || user.role === "administrator") {
      return;
    }

    const coOrg = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id
         FROM public.tournament_organizers
        WHERE tournament_id = $1 AND steam_id = $2
        LIMIT 1`,
      [tournamentId, user.steam_id],
    );
    if (coOrg && coOrg.length > 0) {
      return;
    }

    throw new ForbiddenException("Not the tournament organizer");
  }

  private async requireAward(awardId: string): Promise<AwardRow> {
    const [award] = await this.postgres.query<AwardRow[]>(
      `SELECT * FROM public.awards WHERE id = $1 LIMIT 1`,
      [awardId],
    );

    if (!award) {
      throw new NotFoundException("Award not found");
    }

    return award;
  }

  private async getTournamentAward(
    tournamentId: string,
    placement: number,
  ): Promise<TournamentAwardRow | null> {
    const rows = await this.postgres.query<TournamentAwardRow[]>(
      `SELECT * FROM public.tournament_awards
        WHERE tournament_id = $1 AND placement = $2
        LIMIT 1`,
      [tournamentId, String(placement)],
    );
    return rows?.[0] || null;
  }

  // A team award has to reach the people on the team, otherwise it only ever
  // shows on the team page. Tournament placements already work this way — the
  // calculation writes one team row plus a row per roster player — so a
  // hand-granted team award fans out the same way. Invites are skipped, and
  // members who already hold the award are filtered out here rather than left
  // to ON CONFLICT: tbi_award_recipients raises on a duplicate instead of
  // conflicting, so one existing holder would otherwise fail the whole grant.
  private async grantToRoster(
    input: GrantAwardInput,
    tournamentTeamId: string | null,
  ): Promise<Array<{ id: string; player_steam_id: string }>> {
    // RETURNING, so only the players who actually received the award are
    // notified -- the NOT EXISTS below skips anyone who already held it, and
    // re-notifying them would be a lie.
    return await this.postgres.query<
      Array<{ id: string; player_steam_id: string }>
    >(
      `INSERT INTO public.award_recipients
          (award_id, player_steam_id, tournament_id, tournament_team_id,
           event_id, season_id, league_season_id,
           source, awarded_by_steam_id, note)
        SELECT $1, roster.player_steam_id, $2, $3, $4, $5, $6, 'manual', $7, $8
          FROM public.team_roster roster
         WHERE roster.team_id = $9
           AND roster.role <> 'Invite'
           AND NOT EXISTS (
             SELECT 1 FROM public.award_recipients held
              WHERE held.award_id = $1
                AND held.player_steam_id = roster.player_steam_id
                AND held.tournament_id IS NOT DISTINCT FROM $2
                AND held.event_id IS NOT DISTINCT FROM $4
                AND held.season_id IS NOT DISTINCT FROM $5
                AND held.league_season_id IS NOT DISTINCT FROM $6
           )
        RETURNING id, player_steam_id::text AS player_steam_id`,
      [
        input.award_id,
        input.tournament_id ?? null,
        tournamentTeamId,
        input.event_id ?? null,
        input.season_id ?? null,
        input.league_season_id ?? null,
        input.awarded_by_steam_id,
        input.note ?? null,
        input.team_id,
      ],
    );
  }

  // A tournament-scoped grant must name the entry the recipient played as: it
  // keeps the award tied to an actual participant, and lets the partial unique
  // keys dedupe the grant against the calculated rows.
  private async resolveTournamentTeam(
    tournamentId: string,
    playerSteamId: string | null,
    teamId: string | null,
  ): Promise<string> {
    const rows = teamId
      ? await this.postgres.query<Array<{ id: string }>>(
          `SELECT id FROM public.tournament_teams
            WHERE tournament_id = $1 AND team_id = $2
            LIMIT 1`,
          [tournamentId, teamId],
        )
      : await this.postgres.query<Array<{ id: string }>>(
          `SELECT tournament_team_id AS id
             FROM public.tournament_team_roster
            WHERE tournament_id = $1 AND player_steam_id = $2
            LIMIT 1`,
          [tournamentId, playerSteamId],
        );

    if (!rows || rows.length === 0) {
      throw new BadRequestException("Recipient is not part of this tournament");
    }

    return rows[0].id;
  }

  private isValidPlacement(placement: number): boolean {
    return Number.isInteger(placement) && placement >= 0 && placement <= 3;
  }

  private isValidSilhouette(silhouette?: number | null): boolean {
    if (silhouette === null || silhouette === undefined) {
      return true;
    }
    return Number.isInteger(silhouette) && silhouette >= 0 && silhouette <= 4;
  }

  // image_url is the S3 key (`awards/<file>`, or `trophies/<file>` from before
  // the rename); the file is only served at `/avatars/awards/<file>`.
  public static imagePath(imageUrl?: string | null): string | null {
    if (!imageUrl) {
      return null;
    }
    if (/^https?:\/\//i.test(imageUrl)) {
      return imageUrl;
    }
    return `/avatars/awards/${imageUrl.replace(/^(awards|trophies)\//, "")}`;
  }

  private buildPath(slug: string, mimetype: string): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `awards/${slug}-${hash}.${ext}`;
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) {
      return "image/png";
    }
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (filename.endsWith(".webp")) {
      return "image/webp";
    }
    return "application/octet-stream";
  }
}
