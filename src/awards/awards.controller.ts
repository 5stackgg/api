import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  ParseIntPipe,
  Req,
  Res,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SystemService } from "src/system/system.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";
import { AwardsService } from "./awards.service";
import { User } from "../auth/types/User";

// Image routes live under the /avatars prefix so award artwork reuses the
// ingress path already exposed for every other uploaded image; the Hasura
// actions below are dispatched by method name, not by route, so the prefix
// only affects the REST endpoints. AvatarsController owns no awards/* route.
@Controller("avatars")
export class AwardsController {
  constructor(
    private readonly awards: AwardsService,
    private readonly system: SystemService,
  ) {}

  @HasuraAction()
  public async saveAward(data: {
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
    user?: User;
  }) {
    const user = await this.assertCanCreate(data.user);
    // Scoping an award stamps ownership, so a tournament's bespoke awards do
    // not clutter every other picker. Only a tournament has a delegated
    // organizer role; the platform-wide scopes stay administrator-only.
    if (data.tournament_id) {
      await this.awards.requireOrganizer(data.tournament_id, user);
    }
    if (
      (data.event_id || data.season_id || data.league_season_id) &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException(
        "Only administrators can scope an award to an event, season or league",
      );
    }
    return await this.awards.saveAward(data, user.steam_id);
  }

  @HasuraAction()
  public async deleteAward(data: { id: string; user?: User }) {
    await this.assertCanCreate(data.user);
    await this.awards.deleteAward(data.id);
    return { success: true };
  }

  @HasuraAction()
  public async grantAward(data: {
    award_id: string;
    player_steam_id?: string | null;
    team_id?: string | null;
    tournament_id?: string | null;
    event_id?: string | null;
    season_id?: string | null;
    league_season_id?: string | null;
    note?: string | null;
    user?: User;
  }) {
    const user = await this.assertCanGrant(data.user, data);
    return await this.awards.grantAward({
      award_id: data.award_id,
      player_steam_id: data.player_steam_id,
      team_id: data.team_id,
      tournament_id: data.tournament_id,
      event_id: data.event_id,
      season_id: data.season_id,
      league_season_id: data.league_season_id,
      note: data.note,
      awarded_by_steam_id: user.steam_id,
    });
  }

  @HasuraAction()
  public async revokeAward(data: { id: string; user?: User }) {
    const recipient = await this.awards.getRecipient(data.id);
    await this.assertCanGrant(data.user, recipient);
    await this.awards.revokeAward(data.id);
    return { success: true };
  }

  @HasuraAction()
  public async setTournamentAward(data: {
    tournament_id: string;
    placement: number;
    award_id?: string | null;
    custom_name?: string | null;
    silhouette?: number | null;
    user?: User;
  }) {
    const user = this.requireUser(data.user);
    await this.awards.requireOrganizer(data.tournament_id, user);
    return await this.awards.setTournamentAward(data);
  }

  @Post("awards/:awardId")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadAwardImage(
    @Req() request: Request,
    @Param("awardId") awardId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    await this.assertCanCreate(request.user as User | undefined);
    const path = await this.awards.uploadAwardImage(
      awardId,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("awards/:awardId")
  public async removeAwardImage(
    @Req() request: Request,
    @Param("awardId") awardId: string,
  ) {
    await this.assertCanCreate(request.user as User | undefined);
    await this.awards.removeAwardImage(awardId);
    return { success: true };
  }

  @Post("awards/tournament/:tournamentId/:placement")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadTournamentAwardImage(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @Param("placement", ParseIntPipe) placement: number,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request.user as User | undefined);
    await this.awards.requireOrganizer(tournamentId, user);
    const path = await this.awards.uploadTournamentAwardImage(
      tournamentId,
      placement,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("awards/tournament/:tournamentId/:placement")
  public async removeTournamentAwardImage(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @Param("placement", ParseIntPipe) placement: number,
  ) {
    const user = this.requireUser(request.user as User | undefined);
    await this.awards.requireOrganizer(tournamentId, user);
    await this.awards.removeTournamentAwardImage(tournamentId, placement);
    return { success: true };
  }

  @Get("awards/:filename")
  public async serve(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    // The character class alone still admits ".." — the key is built by
    // concatenation, so keep anything that reads as a path segment out.
    if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes("..")) {
      throw new NotFoundException("Award image not found");
    }

    const result = await this.awards.getStream(filename);
    if (!result) {
      throw new NotFoundException("Award image not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    result.stream.pipe(res);
  }

  private async assertCanCreate(user?: User): Promise<User> {
    const resolved = this.requireUser(user);

    const createRole = (await this.system.getSetting(
      SystemSettingName.CreateAwardsRole,
      "administrator",
    )) as e_player_roles_enum;

    if (!isRoleAbove(resolved.role, createRole)) {
      throw new ForbiddenException(
        "You do not have permission to manage awards",
      );
    }

    return resolved;
  }

  // Tournament organizers can always hand out awards inside their own
  // tournament, regardless of where the global grant floor sits. No other scope
  // has a delegated role, so an event/season/league grant needs the floor.
  private async assertCanGrant(
    user: User | undefined,
    scope: {
      tournament_id?: string | null;
      event_id?: string | null;
      season_id?: string | null;
      league_season_id?: string | null;
    },
  ): Promise<User> {
    const resolved = this.requireUser(user);

    this.awards.assertSingleScope(scope);

    const grantRole = (await this.system.getSetting(
      SystemSettingName.GrantAwardsRole,
      "administrator",
    )) as e_player_roles_enum;

    if (isRoleAbove(resolved.role, grantRole)) {
      return resolved;
    }

    if (!scope.tournament_id) {
      throw new ForbiddenException(
        "You do not have permission to grant awards",
      );
    }

    await this.awards.requireOrganizer(scope.tournament_id, resolved);
    return resolved;
  }

  private requireUser(user?: User): User {
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }
}
