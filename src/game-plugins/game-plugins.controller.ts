import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { GamePluginsService } from "./game-plugins.service";
import { GameModesService } from "./game-modes.service";
import { isRoleAbove } from "../utilities/isRoleAbove";

@Controller("game-plugins")
export class GamePluginsController {
  constructor(
    private readonly gamePlugins: GamePluginsService,
    private readonly gameModes: GameModesService,
    private readonly hasura: HasuraService,
  ) {}

  // The node connector converges itself: it asks what it should have, installs
  // the difference, and reports back. Both routes are node-to-API and carry the
  // admin secret rather than a user session.
  @Get("node/:nodeId/desired")
  public async desired(
    @Req() request: Request,
    @Param("nodeId") nodeId: string,
  ) {
    this.assertNode(request);

    return await this.gamePlugins.desiredForNode(nodeId);
  }

  // Progress, as opposed to the finished inventory /state reports. Without it
  // the panel has to infer what a node is doing from the absence of a result,
  // which cannot tell "not told yet" apart from "downloading right now".
  @Post("node/:nodeId/status")
  public async reportStatus(
    @Req() request: Request,
    @Param("nodeId") nodeId: string,
    @Body()
    body: {
      slug: string;
      status: "Installing" | "Failed" | "Removing";
      version?: string | null;
      error?: string | null;
    },
  ) {
    this.assertNode(request);

    await this.gamePlugins.recordNodeProgress(nodeId, body);

    return { success: true };
  }

  @Post("node/:nodeId/state")
  public async reportState(
    @Req() request: Request,
    @Param("nodeId") nodeId: string,
    @Body()
    body: {
      plugins: Array<{
        slug: string;
        version: string | null;
        runtime: string | null;
        source: "managed" | "manual";
      }>;
    },
  ) {
    this.assertNode(request);

    await this.gamePlugins.recordNodeState(nodeId, body?.plugins ?? []);

    return { success: true };
  }

  private assertNode(request: Request): void {
    if (!this.hasura.checkSecret(request.headers["hasura-admin-secret"] as string)) {
      throw new ForbiddenException("Invalid node credentials");
    }
  }

  @HasuraAction()
  public async syncPluginRegistry(data: { user: User }) {
    this.assertAdministrator(data.user);

    return await this.gamePlugins.syncRegistry();
  }

  // Installing is a statement of intent, not a fan-out. Nodes converge to it
  // themselves, which is what makes a node that is offline now -- or that joins
  // later -- end up with the same set.
  @HasuraAction()
  public async installGamePlugin(data: {
    user: User;
    slug: string;
    version?: string;
  }) {
    this.assertAdministrator(data.user);

    await this.gamePlugins.requestInstall(data.slug, data.version);

    return { success: true };
  }

  @HasuraAction()
  public async uninstallGamePlugin(data: {
    user: User;
    slug: string;
    force?: boolean;
  }) {
    this.assertAdministrator(data.user);

    await this.gamePlugins.requestUninstall(data.slug, data.force === true);

    return { success: true };
  }

  @HasuraAction()
  public async reconcileNodePlugins(data: { user: User; nodeId: string }) {
    this.assertAdministrator(data.user);

    return { detected: await this.gamePlugins.syncNode(data.nodeId) };
  }

  @HasuraAction()
  public async getPluginReadme(data: {
    user: User;
    slug: string;
    runtime?: string;
  }) {
    this.assertAdministrator(data.user);

    const readme = await this.gamePlugins.readme(data.slug, data.runtime);

    return {
      repo: readme?.repo ?? null,
      content: readme?.content ?? null,
      format: readme?.format ?? null,
      url: readme?.url ?? null,
    };
  }

  @HasuraAction()
  public async previewGameMode(data: { user: User; gameModeId: string }) {
    this.assertAdministrator(data.user);

    const mode = await this.gameModes.resolve(data.gameModeId);

    if (!mode) {
      return { enabledPlugins: "", cfg: null, extraGameParams: null };
    }

    return {
      enabledPlugins: mode.enabledPlugins,
      cfg: mode.cfg,
      extraGameParams: mode.extraGameParams,
    };
  }

  // Installing a plugin runs third-party code on every server the node hosts,
  // which is a strictly larger capability than anything below administrator.
  private assertAdministrator(user: User): void {
    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw new ForbiddenException("Administrator access required");
    }
  }
}
