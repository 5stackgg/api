import crypto from "crypto";
import { Readable } from "stream";
import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";
import { User } from "../auth/types/User";

export type AvatarKind = "teams" | "players";

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

@Injectable()
export class AvatarsService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
  ) {}

  async uploadTeamAvatar(
    teamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        avatar_url: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (
      teams_by_pk.owner_steam_id !== user.steam_id &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException("You do not own this team");
    }

    const path = this.buildPath("teams", teamId, mimetype);

    await this.s3.put(path, buffer);

    if (teams_by_pk.avatar_url && teams_by_pk.avatar_url !== path) {
      await this.s3.remove(teams_by_pk.avatar_url);
    }

    await this.hasura.mutation({
      update_teams_by_pk: {
        __args: {
          pk_columns: { id: teamId },
          _set: { avatar_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded team ${teamId} avatar to ${path}`);
    return path;
  }

  async removeTeamAvatar(teamId: string, user: User): Promise<void> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        avatar_url: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (
      teams_by_pk.owner_steam_id !== user.steam_id &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException("You do not own this team");
    }

    if (teams_by_pk.avatar_url) {
      await this.s3.remove(teams_by_pk.avatar_url);
    }

    await this.hasura.mutation({
      update_teams_by_pk: {
        __args: {
          pk_columns: { id: teamId },
          _set: { avatar_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed team ${teamId} avatar`);
  }

  async uploadPlayerAvatar(
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException("You cannot change this player's avatar");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        custom_avatar_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    const path = this.buildPath("players", steamId, mimetype);

    await this.s3.put(path, buffer);

    if (
      players_by_pk.custom_avatar_url &&
      players_by_pk.custom_avatar_url !== path
    ) {
      await this.s3.remove(players_by_pk.custom_avatar_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { custom_avatar_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded player ${steamId} avatar to ${path}`);
    return path;
  }

  async removePlayerAvatar(steamId: string, user: User): Promise<void> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException("You cannot change this player's avatar");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        custom_avatar_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    if (players_by_pk.custom_avatar_url) {
      await this.s3.remove(players_by_pk.custom_avatar_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { custom_avatar_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed player ${steamId} custom avatar`);
  }

  async getStream(
    kind: AvatarKind,
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    const key = `avatars/${kind}/${filename}`;

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

  private buildPath(kind: AvatarKind, id: string, mimetype: string): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `avatars/${kind}/${id}-${hash}.${ext}`;
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg"))
      return "image/jpeg";
    if (filename.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
  }
}
