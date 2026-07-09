import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import {
  DEFAULT_PLUGIN_RUNTIME,
  GameServersConfig,
  isPluginRuntime,
  PluginRuntime,
} from "src/configs/types/GameServersConfig";

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
    pin?: {
      pin_plugin_version?: string | null;
      pin_plugin_runtime?: string | null;
    },
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
}
