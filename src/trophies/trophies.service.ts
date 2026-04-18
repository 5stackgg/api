import crypto from "crypto";
import { Readable } from "stream";
import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

interface TrophyConfigRow {
  id: string;
  image_url: string | null;
}

@Injectable()
export class TrophiesService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly postgres: PostgresService,
  ) {}

  async uploadTrophy(
    tournamentId: string,
    placement: number,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (!this.isValidPlacement(placement)) {
      throw new ForbiddenException("Invalid placement");
    }

    await this.requireOrganizer(tournamentId, user);

    const existing = await this.getConfig(tournamentId, placement);
    const path = this.buildPath(tournamentId, placement, mimetype);

    await this.s3.put(path, buffer);

    if (existing?.image_url && existing.image_url !== path) {
      await this.s3.remove(existing.image_url);
    }

    if (existing) {
      await this.postgres.query(
        `UPDATE public.tournament_trophy_configs
            SET image_url = $1, updated_at = now()
          WHERE id = $2`,
        [path, existing.id],
      );
    } else {
      await this.postgres.query(
        `INSERT INTO public.tournament_trophy_configs
            (tournament_id, placement, image_url)
          VALUES ($1, $2, $3)`,
        [tournamentId, String(placement), path],
      );
    }

    this.logger.log(
      `Uploaded tournament ${tournamentId} placement ${placement} trophy to ${path}`,
    );
    return path;
  }

  async removeTrophy(
    tournamentId: string,
    placement: number,
    user: User,
  ): Promise<void> {
    if (!this.isValidPlacement(placement)) {
      throw new ForbiddenException("Invalid placement");
    }

    await this.requireOrganizer(tournamentId, user);

    const existing = await this.getConfig(tournamentId, placement);
    if (!existing) return;

    if (existing.image_url) {
      await this.s3.remove(existing.image_url);
    }

    await this.postgres.query(
      `UPDATE public.tournament_trophy_configs
          SET image_url = NULL, updated_at = now()
        WHERE id = $1`,
      [existing.id],
    );

    this.logger.log(
      `Removed tournament ${tournamentId} placement ${placement} trophy image`,
    );
  }

  async getStream(
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    const key = `trophies/${filename}`;

    if (!(await this.s3.has(key))) {
      return null;
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

  private async requireOrganizer(
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

    if (isOrganizer || user.role === "administrator") return;

    const coOrg = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id
         FROM public.tournament_organizers
        WHERE tournament_id = $1 AND steam_id = $2
        LIMIT 1`,
      [tournamentId, user.steam_id],
    );
    if (coOrg && coOrg.length > 0) return;

    throw new ForbiddenException("Not the tournament organizer");
  }

  private async getConfig(
    tournamentId: string,
    placement: number,
  ): Promise<TrophyConfigRow | null> {
    const rows = await this.postgres.query<TrophyConfigRow[]>(
      `SELECT id, image_url
         FROM public.tournament_trophy_configs
        WHERE tournament_id = $1 AND placement = $2
        LIMIT 1`,
      [tournamentId, String(placement)],
    );
    return rows?.[0] || null;
  }

  private isValidPlacement(placement: number): boolean {
    return Number.isInteger(placement) && placement >= 0 && placement <= 3;
  }

  private buildPath(
    tournamentId: string,
    placement: number,
    mimetype: string,
  ): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `trophies/${tournamentId}-${placement}-${hash}.${ext}`;
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg"))
      return "image/jpeg";
    if (filename.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
  }
}
