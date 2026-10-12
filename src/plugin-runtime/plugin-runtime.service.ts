import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import {
  DEFAULT_PLUGIN_RUNTIME,
  GameServersConfig,
  isPluginRuntime,
  PluginRuntime,
  PRACTICE_PLUGIN_RUNTIME,
} from "src/configs/types/GameServersConfig";

type PluginPin = {
  pin_plugin_version?: string | null;
  pin_plugin_runtime?: string | null;
};

// Depends on postgres + config only. Reaching for SystemService here instead would
// close a module cycle back through GameServerNodeModule.
@Injectable()
export class PluginRuntimeService {
  constructor(
    private readonly config: ConfigService,
    private readonly postgres: PostgresService,
  ) {}

  public async getPluginRuntime(): Promise<PluginRuntime> {
    const [setting] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.GameServerPluginRuntime],
    );

    return isPluginRuntime(setting?.value)
      ? setting.value
      : DEFAULT_PLUGIN_RUNTIME;
  }

  // A pin carries the runtime it was made against, so a node pinned under one
  // framework stays on that framework even if the deployment-wide setting moves.
  public async resolvePluginRuntime(pin?: {
    pin_plugin_runtime?: string | null;
  }): Promise<PluginRuntime> {
    if (isPluginRuntime(pin?.pin_plugin_runtime)) {
      return pin.pin_plugin_runtime;
    }

    return await this.getPluginRuntime();
  }

  public async resolveGameServerPluginImage(
    pin?: PluginPin,
    runtime?: PluginRuntime,
  ): Promise<string> {
    const { serverImageOverride, pluginRuntimeImages } =
      this.config.get<GameServersConfig>("gameServers");

    const pinnedVersion = pin?.pin_plugin_version;

    if (serverImageOverride) {
      if (!pinnedVersion) {
        return serverImageOverride;
      }
      return serverImageOverride.replace(/:.+$/, `:v${pinnedVersion}`);
    }

    const repository =
      pluginRuntimeImages[runtime ?? (await this.resolvePluginRuntime(pin))];

    return `${repository}:${pinnedVersion ? `v${pinnedVersion}` : "latest"}`;
  }

  public async resolvePracticeServerImage(pin?: PluginPin): Promise<string> {
    return await this.resolveGameServerPluginImage(
      { pin_plugin_version: await this.practicePluginVersion(pin) },
      PRACTICE_PLUGIN_RUNTIME,
    );
  }

  // SwiftlyS2 can trail a CS2 update, which is when an install moves its
  // matches over to CounterStrikeSharp; practice has nowhere to move. A node
  // that has not reported a build yet passes, as plugin_supported lets it.
  public async supportsPractice(
    node: PluginPin & { build_id?: number | null },
  ): Promise<boolean> {
    if (node.build_id == null) {
      return true;
    }

    const [row] = await this.postgres.query<Array<{ supported: boolean }>>(
      `SELECT public.game_version_supports_plugin($1::integer, $2::text, $3::text) AS supported`,
      [
        node.build_id,
        await this.practicePluginVersion(node),
        PRACTICE_PLUGIN_RUNTIME,
      ],
    );

    return row?.supported === true;
  }

  // The runtimes number their releases separately, so a pin made against
  // CounterStrikeSharp names an unrelated SwiftlyS2 build; practice takes the
  // latest SwiftlyS2 one instead.
  private async practicePluginVersion(pin?: PluginPin): Promise<string | null> {
    if (!pin?.pin_plugin_version) {
      return null;
    }

    return (await this.resolvePluginRuntime(pin)) === PRACTICE_PLUGIN_RUNTIME
      ? pin.pin_plugin_version
      : null;
  }
}
