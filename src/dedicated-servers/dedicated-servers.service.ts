import { Injectable, Logger } from "@nestjs/common";
import { CoreV1Api, AppsV1Api, KubeConfig } from "@kubernetes/client-node";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { EncryptionService } from "src/encryption/encryption.service";
import { HasuraService } from "src/hasura/hasura.service";
import { e_server_types_enum } from "../../generated";
import { RconService } from "src/rcon/rcon.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { Redis } from "ioredis";
import { SystemService } from "src/system/system.service";
import { PluginRuntimeService } from "src/plugin-runtime/plugin-runtime.service";
import {
  GameModesService,
  ResolvedGameMode,
} from "../game-plugins/game-modes.service";
import { MapRotationService } from "../game-plugins/map-rotation.service";
import { PluginCvarsService } from "../game-plugins/plugin-cvars.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { DISCORD_COLORS } from "src/notifications/utilities/constants";
import { MarkDedicatedServerOffline } from "src/game-server-node/jobs/MarkDedicatedServerOffline";
import { PostgresService } from "src/postgres/postgres.service";
import { ServerRosterService } from "src/server-roster/server-roster.service";

type UnreachableStreak = {
  since: number;
  last: number;
  reported: boolean;
};

@Injectable()
export class DedicatedServersService {
  private static readonly rebuilds = new Map<string, Promise<boolean>>();

  // One failed RCON ping says little: a node dying under the server is only
  // marked Offline up to 90s later, and a restart takes a while to boot. A
  // server is reported once it has stayed unreachable this long.
  public static readonly UNREACHABLE_ALERT_AFTER_MS = 2 * 60 * 1000;

  private static readonly UNREACHABLE_GAP_MS = 90 * 1000;

  private static readonly UNREACHABLE_KEY = "dedicated-servers:unreachable";

  public static readonly ACTIVE_MIGRATION_STATUSES = [
    "Queued",
    "Stopping",
    "Transferring",
    "Finalizing",
  ];

  // Only while the move has the server down. A queued move has not touched
  // it yet, and the node change Finalizing commits is what deploys it on the
  // new node.
  public static readonly HOLDING_MIGRATION_STATUSES = [
    "Stopping",
    "Transferring",
  ];

  private appConfig: AppConfig;
  private gameServerConfig: GameServersConfig;
  private readonly namespace: string;

  private core: CoreV1Api;
  private apps: AppsV1Api;

  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly encryption: EncryptionService,
    private readonly RconService: RconService,
    private readonly redisManager: RedisManagerService,
    private readonly systemService: SystemService,
    private readonly pluginRuntimeService: PluginRuntimeService,
    private readonly gameModesService: GameModesService,
    private readonly mapRotationService: MapRotationService,
    private readonly notifications: NotificationsService,
    private readonly postgres: PostgresService,
    private readonly pluginCvars: PluginCvarsService,
  ) {
    this.redis = this.redisManager.getConnection();

    this.appConfig = this.config.get<AppConfig>("app");
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");

    this.namespace = this.gameServerConfig.namespace;

    const kc = new KubeConfig();
    kc.loadFromDefault();

    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
  }

  // Exactly one 5stack plugin per server: the match plugin on Ranked, the
  // utility plugin on Practice, and on a community server, which has no match
  // plugin to carry sanctions, the player management plugin. It is CS2 only.
  public static pluginInstallEnvironment(server: {
    type: string;
    game: string;
  }): Array<{ name: string; value: string }> {
    const community = server.type !== "Ranked" && server.type !== "Practice";

    return [
      {
        name: "INSTALL_5STACK_PLUGIN",
        value: server.type === "Ranked" ? "true" : "false",
      },
      {
        name: "INSTALL_UTILITY_PRACTICE_PLUGIN",
        value: server.type === "Practice" ? "true" : "false",
      },
      {
        name: "INSTALL_PLAYER_MANAGEMENT_PLUGIN",
        value: community && server.game !== "csgo" ? "true" : "false",
      },
    ];
  }

  public async setupDedicatedServer(serverId: string): Promise<boolean> {
    this.logger.log(`[${serverId}] assigning dedicated server`);

    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        id: true,
        host: true,
        type: true,
        port: true,
        tv_port: true,
        game: true,
        max_players: true,
        api_password: true,
        rcon_password: true,
        connect_password: true,
        game_server_node: {
          id: true,
          pin_plugin_version: true,
          pin_plugin_runtime: true,
          supports_cpu_pinning: true,
        },
        server_region: {
          is_lan: true,
          steam_relay: true,
        },
      },
    });

    try {
      this.logger.verbose(
        `[${serverId}] create deployment for dedicated server`,
      );

      const gameServerNodeId = server.game_server_node?.id;
      const steamRelay = server.server_region?.steam_relay || false;

      let cpus: string;
      if (server.game_server_node?.supports_cpu_pinning) {
        const { settings } = await this.hasura.query({
          settings: {
            __args: {
              where: {
                _or: [
                  {
                    name: {
                      _eq: "enable_cpu_pinning",
                    },
                  },
                  {
                    name: {
                      _eq: "number_of_cpus_per_server",
                    },
                  },
                ],
              },
            },
            name: true,
            value: true,
          },
        });

        const cpuPinning = settings.find(
          (setting) => setting.name === "enable_cpu_pinning",
        );

        if (cpuPinning?.value === "true") {
          const numberOfCpus = settings.find(
            (setting) => setting.name === "number_of_cpus_per_server",
          );
          cpus = numberOfCpus?.value || "2";
        }
      }

      const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");
      const serverfilesVolumeName =
        server.game === "csgo"
          ? `serverfiles-csgo-${sanitizedGameServerNodeId}`
          : `serverfiles-${sanitizedGameServerNodeId}`;

      const pluginRuntime =
        await this.pluginRuntimeService.resolvePluginRuntime(
          server.game_server_node,
        );

      const pluginImage =
        await this.pluginRuntimeService.resolveGameServerPluginImage(
          server.game_server_node,
          pluginRuntime,
        );

      // Seeded here so out-of-date checks know the framework even before the
      // plugin's first ping; the ping overwrites it with what actually loaded.
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: {
              id: serverId,
            },
            _set: {
              plugin_runtime: pluginRuntime,
            },
          },
          __typename: true,
        },
      });

      // A Ranked server resolves to no mode by design, so matchmaking capacity
      // always comes up on a clean plugin set.
      const resolvedMode =
        await this.gameModesService.resolveForServer(serverId);

      // Ranked and Practice servers host matches, and a match execs each
      // plugin's cvars itself.
      const community = server.type !== "Ranked" && server.type !== "Practice";

      const gameMode = DedicatedServersService.withServerCfg(
        resolvedMode,
        server.type,
        community
          ? await this.gameModesService.pluginCfgLayers(resolvedMode)
          : [],
        community
          ? await this.gameModesService.serverCfgLayers(serverId, resolvedMode)
          : [],
      );

      const gameModeEnvironment =
        this.gameModesService.environmentFor(gameMode);

      const startMap = MapRotationService.startMap(
        await this.mapRotationService.forServer(serverId),
      );

      const dedicatedServerDeploymentName =
        this.getDedicatedServerDeploymentName(serverId);

      await this.apps.createNamespacedDeployment({
        namespace: this.namespace,
        body: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: dedicatedServerDeploymentName,
          },
          spec: {
            replicas: 1,
            strategy: {
              type: "Recreate",
            },
            selector: {
              matchLabels: {
                app: dedicatedServerDeploymentName,
              },
            },
            template: {
              metadata: {
                name: dedicatedServerDeploymentName,
                labels: {
                  app: dedicatedServerDeploymentName,
                },
              },
              spec: {
                dnsConfig: {
                  options: [
                    {
                      name: "ndots",
                      value: "1",
                    },
                  ],
                },
                hostNetwork: true,
                affinity: {
                  nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                      nodeSelectorTerms: [
                        {
                          matchExpressions: [
                            {
                              key: "kubernetes.io/hostname",
                              operator: "In",
                              values: [gameServerNodeId],
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
                containers: [
                  {
                    name: "game-server",
                    image: pluginImage,
                    ...(cpus
                      ? {
                          resources: {
                            requests: { cpu: cpus },
                            limits: { cpu: cpus },
                          },
                        }
                      : {}),
                    ports: [
                      { containerPort: server.port },
                      { containerPort: server.port, protocol: "UDP" },
                      { containerPort: server.tv_port, protocol: "TCP" },
                      { containerPort: server.tv_port, protocol: "UDP" },
                    ],
                    env: [
                      {
                        name: "GAME_ID",
                        value: server.game === "csgo" ? "740" : "730",
                      },
                      {
                        name: "SERVER_TYPE",
                        value: server.type,
                      },
                      ...DedicatedServersService.pluginInstallEnvironment(
                        server,
                      ),
                      {
                        name: "GAME_NODE_SERVER",
                        value: "true",
                      },
                      { name: "SERVER_PORT", value: server.port.toString() },
                      { name: "TV_PORT", value: server.tv_port.toString() },
                      {
                        name: "RCON_PASSWORD",
                        value: await this.encryption.decrypt(
                          server.rcon_password,
                        ),
                      },
                      // TODO - number of players
                      {
                        name: "EXTRA_GAME_PARAMS",
                        value: [
                          // CS2 (since its January 2026 update) drops
                          // "workshop-disallowed" cvars from every cfg exec'd
                          // on a workshop map without it.
                          server.game === "csgo"
                            ? null
                            : "-disable_workshop_command_filtering",
                          `-maxplayers ${server.type === "Ranked" ? 16 : server.max_players}`,
                          `+map ${startMap && !startMap.workshop_map_id ? startMap.name : "de_dust2"}`,
                          ...DedicatedServersService.launchMode(
                            server.type,
                            gameMode?.valveMode,
                          ),
                          server.connect_password
                            ? `+sv_password ${server.connect_password}`
                            : null,
                          gameMode?.extraGameParams,
                          // CS2 only logs on to Steam once a level is loaded, so
                          // on its own this leaves the server idle with no map;
                          // after the stock +map it downloads and replaces it.
                          startMap?.workshop_map_id
                            ? `+host_workshop_map ${startMap.workshop_map_id}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" "),
                      },
                      { name: "SERVER_ID", value: server.id },
                      {
                        name: "SERVER_API_PASSWORD",
                        value: server.api_password,
                      },
                      {
                        name: "API_DOMAIN",
                        value: this.appConfig.apiDomain,
                      },
                      {
                        name: "RELAY_DOMAIN",
                        value: this.appConfig.relayDomain,
                      },
                      {
                        name: "DEMOS_DOMAIN",
                        value: this.appConfig.demosDomain,
                      },
                      {
                        name: "WS_DOMAIN",
                        value: this.appConfig.wsDomain,
                      },
                      {
                        name: "STEAM_RELAY",
                        value: steamRelay ? "true" : "false",
                      },
                      ...gameModeEnvironment,
                    ],
                    volumeMounts: [
                      {
                        name: `steamcmd-${sanitizedGameServerNodeId}`,
                        mountPath: "/serverdata/steamcmd",
                      },
                      {
                        name: serverfilesVolumeName,
                        mountPath: "/serverdata/serverfiles",
                      },
                      {
                        name: `demos-${sanitizedGameServerNodeId}`,
                        mountPath: "/opt/demos",
                      },
                      {
                        name: `dedicated-server-data-${server.id}`,
                        mountPath: `/opt/custom-plugins`,
                      },
                      // A dedicated server only ever saw its own directory, so
                      // a plugin installed on the node reached every on-demand
                      // match server and none of these. Mounted read-write
                      // because a plugin writes its config on first load and
                      // that has to survive the pod.
                      {
                        name: `custom-plugins-${sanitizedGameServerNodeId}`,
                        mountPath: `/opt/node-plugins`,
                      },
                    ],
                  },
                ],
                volumes: [
                  {
                    name: `steamcmd-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `steamcmd-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: serverfilesVolumeName,
                    persistentVolumeClaim: {
                      claimName: `${serverfilesVolumeName}-claim`,
                    },
                  },
                  {
                    name: `demos-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `demos-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `dedicated-server-data-${server.id}`,
                    hostPath: {
                      type: "DirectoryOrCreate",
                      path: `/opt/5stack/servers/${server.id}`,
                    },
                  },
                  {
                    name: `custom-plugins-${sanitizedGameServerNodeId}`,
                    hostPath: {
                      type: "DirectoryOrCreate",
                      path: `/opt/5stack/custom-plugins`,
                    },
                  },
                ],
              },
            },
          },
        },
      });

      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              connected: false,
              steam_relay: null,
            },
          },
          id: true,
        },
      });

      void this.waitForPodReady(serverId)
        .then(() => {
          setTimeout(async () => {
            this.logger.verbose(`[${serverId}] dedicated server is ready`);
            await this.pingDedicatedServer(serverId);
          }, 10000);
        })
        .catch((error) => {
          this.logger.error(
            `[${serverId}] error waiting for pod to be ready`,
            error,
          );
        });

      return true;
    } catch (error) {
      // AlreadyExists means another rebuild created it; deleting it here would
      // take down the server that rebuild just started.
      if (error?.code?.toString() !== "409") {
        await this.removeDedicatedServer(serverId);
      }

      this.logger.error(
        `[${serverId}] unable to create dedicated server`,
        error?.response?.body?.message || error,
      );

      return false;
    }
  }

  // Remove-then-create is not atomic, and a servers event, a region relay
  // change and the dedicated server settings all trigger it. Overlapping runs
  // can both remove, one creates, and the other fails on AlreadyExists, so
  // they run one at a time per server.
  public async rebuildDedicatedServer(
    serverId: string,
    start = true,
  ): Promise<boolean> {
    const previous =
      DedicatedServersService.rebuilds.get(serverId) ?? Promise.resolve(true);

    const rebuild = previous
      .catch(() => false)
      .then(async () => {
        const shouldStart = start && !(await this.isHeldByMigration(serverId));

        if (start && !shouldStart) {
          this.logger.log(
            `[${serverId}] not starting, the server is being moved to another node`,
          );
        }

        if (shouldStart) {
          await this.expectRestart(serverId);
        }

        await this.removeDedicatedServer(serverId);

        return shouldStart ? await this.setupDedicatedServer(serverId) : true;
      });

    DedicatedServersService.rebuilds.set(serverId, rebuild);

    try {
      return await rebuild;
    } finally {
      if (DedicatedServersService.rebuilds.get(serverId) === rebuild) {
        DedicatedServersService.rebuilds.delete(serverId);
      }
    }
  }

  public async isHeldByMigration(serverId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<unknown>>(
      `SELECT 1 FROM server_migrations WHERE server_id = $1 AND status = ANY($2::text[])`,
      [serverId, DedicatedServersService.HOLDING_MIGRATION_STATUSES],
    );

    return rows.length > 0;
  }

  // Deleting the deployment returns before its pod has exited, and a server
  // still shutting down is still writing to its files.
  public async waitForDedicatedServerStopped(
    serverId: string,
    options: { acceptTerminating: boolean; timeoutMs: number },
  ): Promise<void> {
    const name = this.getDedicatedServerDeploymentName(serverId);
    const deadline = Date.now() + options.timeoutMs;

    while (true) {
      const deployment = await this.apps
        .readNamespacedDeployment({ name, namespace: this.namespace })
        .catch((error): null => {
          if (error?.code?.toString() === "404") {
            return null;
          }

          throw error;
        });

      if (deployment) {
        await this.removeDedicatedServer(serverId);
      }

      const { items: pods } = await this.core.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `app=${name}`,
      });

      if (
        !deployment &&
        (pods.length === 0 ||
          (options.acceptTerminating &&
            pods.every((pod) => !!pod.metadata?.deletionTimestamp)))
      ) {
        return;
      }

      if (Date.now() >= deadline) {
        throw new Error("The server did not stop in time");
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  public async deploymentExists(serverId: string): Promise<boolean> {
    return await this.apps
      .readNamespacedDeployment({
        name: this.getDedicatedServerDeploymentName(serverId),
        namespace: this.namespace,
      })
      .then(() => true)
      .catch((error): boolean => {
        if (error?.code?.toString() === "404") {
          return false;
        }

        throw error;
      });
  }

  public async waitForDeployment(
    serverId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const exists = await this.deploymentExists(serverId).catch(() => false);

      if (exists || Date.now() >= deadline) {
        return exists;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  public async removeDedicatedServer(serverId: string): Promise<void> {
    this.logger.log(`[${serverId}] removing dedicated server`);

    const dedicatedServerDeploymentName = `dedicated-server-${serverId}`;

    try {
      await this.apps.deleteNamespacedDeployment({
        namespace: this.namespace,
        name: dedicatedServerDeploymentName,
      });
    } catch (error) {
      if (error.code.toString() !== "404") {
        throw error;
      }
    } finally {
      await this.redis.hdel("dedicated-servers:stats", serverId);
      await this.redis.hdel(DedicatedServersService.UNREACHABLE_KEY, serverId);

      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              connected: false,
              steam_relay: null,
            },
          },
          id: true,
        },
      });
    }
  }

  // game_type, game_mode and the server config each mode in CS2's
  // gamemodes.txt execs after its own on every map load; a game mode's
  // valve_mode is one of these keys. Rush execs no server config.
  private static readonly VALVE_MODES: Record<
    string,
    { gameType: number; gameMode: number; serverCfg: string | null }
  > = {
    casual: { gameType: 0, gameMode: 0, serverCfg: "gamemode_casual_server" },
    competitive: {
      gameType: 0,
      gameMode: 1,
      serverCfg: "gamemode_competitive_server",
    },
    wingman: {
      gameType: 0,
      gameMode: 2,
      serverCfg: "gamemode_competitive2v2_server",
    },
    retakes: { gameType: 0, gameMode: 5, serverCfg: "gamemode_casual_server" },
    rush: { gameType: 0, gameMode: 6, serverCfg: null },
    armsrace: {
      gameType: 1,
      gameMode: 0,
      serverCfg: "gamemode_armsrace_server",
    },
    deathmatch: {
      gameType: 1,
      gameMode: 2,
      serverCfg: "gamemode_deathmatch_server",
    },
    custom: { gameType: 3, gameMode: 0, serverCfg: "gamemode_custom_server" },
  };

  private static readonly SERVER_TYPE_MODES: Record<string, string> = {
    Ranked: "competitive",
    Competitive: "competitive",
    Casual: "casual",
    Practice: "casual",
    Wingman: "wingman",
    Deathmatch: "deathmatch",
    ArmsRace: "armsrace",
    Retake: "retakes",
    Custom: "custom",
  };

  // A custom mode can name the Valve mode it is built on: the Deathmatch
  // plugin patches Valve's deathmatch rules, which stock Custom never runs.
  public static launchMode(
    type: e_server_types_enum,
    valveMode?: string | null,
  ): Array<string> {
    const mode = DedicatedServersService.valveModeFor(type, valveMode);

    return [`+game_type ${mode.gameType}`, `+game_mode ${mode.gameMode}`];
  }

  private static valveModeFor(
    type: e_server_types_enum,
    valveMode?: string | null,
  ) {
    return (
      DedicatedServersService.VALVE_MODES[valveMode ?? ""] ??
      DedicatedServersService.VALVE_MODES[
        DedicatedServersService.SERVER_TYPE_MODES[type] ?? "casual"
      ]
    );
  }

  // A community server has no match, so the cvars a match would exec -- each
  // loading plugin's, then the mode's -- ride in as the server config CS2
  // execs after the Valve mode's own, on every map load, which is also what
  // keeps them across a rotation. The server's own plugin cvars run last.
  public static withServerCfg(
    mode: ResolvedGameMode | null,
    type: e_server_types_enum,
    pluginCfgs: Array<{ slug: string; cfg: string }> = [],
    serverCfgs: Array<{ slug: string; cfg: string }> = [],
  ): ResolvedGameMode | null {
    const serverCfg = DedicatedServersService.valveModeFor(
      type,
      mode?.valveMode,
    ).serverCfg;

    const cfg = [
      ...pluginCfgs.map((layer) => layer.cfg),
      mode?.cfg ?? "",
      ...serverCfgs.map((layer) => layer.cfg),
    ]
      .filter((block) => block.trim())
      .map((block) => (block.endsWith("\n") ? block : `${block}\n`))
      .join("");

    if (!mode || !cfg || !serverCfg) {
      return mode;
    }

    const files: Record<string, string> = mode.pluginConfigs
      ? JSON.parse(Buffer.from(mode.pluginConfigs, "base64").toString())
      : {};

    files[`cfg/${serverCfg}.cfg`] = cfg;

    return {
      ...mode,
      pluginConfigs: Buffer.from(JSON.stringify(files)).toString("base64"),
    };
  }

  private async getServerStatusInfo(
    serverId: string,
    game: string,
    steamRelayEnabled: boolean,
  ): Promise<{ steamId: string | null; clients_human: number; map: string }> {
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return;
    }

    if (game === "csgo") {
      const output = await rcon.send("status");
      const mapMatch = output.match(/^map\s*:\s*(\S+)/m);
      const playersMatch = output.match(/^players\s*:\s*(\d+)\s+humans/m);
      return {
        steamId: null,
        clients_human: playersMatch ? parseInt(playersMatch[1]) : 0,
        map: mapMatch ? mapMatch[1] : "unknown",
      };
    } else {
      const status = JSON.parse(await rcon.send("status_json"));
      return {
        steamId: steamRelayEnabled ? status.server.steamid : null,
        clients_human: status.server.clients_human,
        map: status.server.map || "unknown",
      };
    }
  }

  public async getServerPlayerList(
    serverId: string,
  ): Promise<Array<{ steam_id: string; name: string; userid: string | null }>> {
    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: { id: serverId },
        game: true,
        connected: true,
      },
    });

    if (!server) {
      throw Error(`unable to find server ${serverId}`);
    }

    if (!server.connected) {
      return [];
    }

    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      throw Error(`unable to connect to rcon for server ${serverId}`);
    }

    try {
      if (server.game === "csgo") {
        return this.parseStatusText(await rcon.send("status"));
      }

      return this.parseStatusJson(await rcon.send("status_json"));
    } finally {
      await this.RconService.disconnect(serverId);
    }
  }

  public async resolveServerUserId(
    serverId: string,
    steamId: string,
  ): Promise<string | null> {
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return null;
    }

    try {
      const output = await rcon.send("status");
      const userid = this.parseUserIdFromStatus(output, steamId);

      if (!userid) {
        this.logger.warn(
          `could not resolve userid for ${steamId} on ${serverId}; status output:\n${output}`,
        );
      }

      return userid;
    } finally {
      await this.RconService.disconnect(serverId);
    }
  }

  private parseUserIdFromStatus(
    output: string,
    steamId: string,
  ): string | null {
    let steamId3: string | null = null;
    let steamLegacy: RegExp | null = null;

    try {
      const accountId = BigInt(steamId) - 76561197960265728n;
      steamId3 = `[U:1:${accountId}]`;
      const authServer = accountId % 2n;
      const accountNumber = accountId / 2n;
      steamLegacy = new RegExp(`STEAM_[0-9]:${authServer}:${accountNumber}\\b`);
    } catch {
      steamId3 = null;
    }

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();

      const matches =
        (steamId3 && line.includes(steamId3)) ||
        line.includes(steamId) ||
        (steamLegacy !== null && steamLegacy.test(line));

      if (!matches) {
        continue;
      }

      const beforeName = line.match(/(\d+)\s+"/);
      if (beforeName) {
        return beforeName[1];
      }

      const anyNumber = line.match(/\d+/);
      if (anyNumber) {
        return anyNumber[0];
      }
    }

    return null;
  }

  private parseStatusJson(
    raw: string,
  ): Array<{ steam_id: string; name: string; userid: string | null }> {
    let status: Record<string, unknown>;
    try {
      status = JSON.parse(raw);
    } catch {
      return [];
    }

    const clients = (status.clients ||
      status.players ||
      (status.server as Record<string, unknown>)?.clients ||
      []) as Array<Record<string, unknown>>;

    if (!Array.isArray(clients)) {
      return [];
    }

    const players: Array<{
      steam_id: string;
      name: string;
      userid: string | null;
    }> = [];

    for (const client of clients) {
      const steamId =
        client.steamid64 ||
        client.steamid ||
        client.steamId ||
        client.xuid ||
        client.accountid;

      if (
        !steamId ||
        client.fake_player ||
        client.is_bot ||
        client.bot ||
        !this.isRealSteamId(`${steamId}`)
      ) {
        continue;
      }

      const userid =
        client.userid ??
        client.userId ??
        client.user_id ??
        client.id ??
        client.slot;

      players.push({
        steam_id: `${steamId}`,
        name: `${client.name ?? ""}`,
        userid: userid != null ? `${userid}` : null,
      });
    }

    return players;
  }

  private isRealSteamId(steamId: string): boolean {
    if (!/^\d+$/.test(steamId)) {
      return false;
    }

    try {
      const id = BigInt(steamId);
      return id >= 76561197960265728n && id <= 76561202255233023n;
    } catch {
      return false;
    }
  }

  private parseStatusText(
    raw: string,
  ): Array<{ steam_id: string; name: string; userid: string | null }> {
    const players: Array<{
      steam_id: string;
      name: string;
      userid: string | null;
    }> = [];

    for (const line of raw.split(/\r?\n/)) {
      const steamMatch = line.match(/STEAM_(\d):(\d):(\d+)/);
      if (!steamMatch) {
        continue;
      }

      const useridMatch = line.match(/^#\s*(\d+)/);
      const nameMatch = line.match(/"([^"]*)"/);

      const universe = BigInt(steamMatch[1]);
      const authServer = BigInt(steamMatch[2]);
      const accountNumber = BigInt(steamMatch[3]);
      const steamId64 =
        76561197960265728n +
        (universe > 0n ? (universe - 1n) << 56n : 0n) +
        accountNumber * 2n +
        authServer;

      players.push({
        steam_id: steamId64.toString(),
        name: nameMatch ? nameMatch[1] : "",
        userid: useridMatch ? useridMatch[1] : null,
      });
    }

    return players;
  }

  public async pingDedicatedServer(serverId: string): Promise<void> {
    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: { id: serverId },
        game: true,
        label: true,
        enabled: true,
        connected: true,
        steam_relay: true,
        game_server_node_id: true,
        server_region: {
          steam_relay: true,
        },
      },
    });

    // A disabled node-managed server has its deployment torn down and may still
    // be shutting down; never bring it back online. External servers keep
    // running independently, so a disabled one can still be online.
    if (!server.enabled && server.game_server_node_id) {
      if (server.connected) {
        await this.hasura.mutation({
          update_servers_by_pk: {
            __args: {
              pk_columns: { id: serverId },
              _set: {
                connected: false,
                offline_at: new Date().toISOString(),
              },
            },
            id: true,
          },
        });
      }
      return;
    }

    // TODO - fix steam relay for csgo
    const steamRelayeEnabled =
      server.game === "csgo" ? false : server.server_region?.steam_relay;
    const statusInfo = await this.getServerStatusInfo(
      serverId,
      server.game,
      steamRelayeEnabled,
    );

    if (!statusInfo) {
      await this.recordUnreachable(serverId, server);
      return;
    }

    await this.redis.hdel(DedicatedServersService.UNREACHABLE_KEY, serverId);

    if (!server.connected) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: { connected: true, offline_at: null },
          },
          id: true,
        },
      });
    }

    const { steamId, clients_human, map } = statusInfo;

    await this.redis.hset(
      "dedicated-servers:stats",
      serverId,
      JSON.stringify({
        clients_human,
        map,
        last_ping: new Date().toISOString(),
      }),
    );

    await this.redis.expire("dedicated-servers:stats", 120);

    if (server.steam_relay !== steamId) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              steam_relay: steamId,
              connected: !steamRelayeEnabled || steamId !== null,
            },
          },
          id: true,
        },
      });
    }

    // Not connected before this ping means it just came up, possibly with a
    // different plugin set than the last time it was asked.
    await this.readPluginCvars(serverId, !server.connected);

    await this.RconService.disconnect(serverId);
  }

  private async readPluginCvars(
    serverId: string,
    restarted: boolean,
  ): Promise<void> {
    try {
      await this.pluginCvars.harvest(
        serverId,
        (name) => this.RconService.listCvars(serverId, name),
        { restarted },
      );
    } catch (error) {
      this.logger.warn(
        `[${serverId}] could not read plugin cvars: ${error?.message ?? error}`,
      );
    }
  }

  public async expectRestart(serverId: string): Promise<void> {
    await MarkDedicatedServerOffline.expectRestart(this.redis, serverId);
  }

  private async recordUnreachable(
    serverId: string,
    server: { label: string; enabled: boolean; connected: boolean },
  ): Promise<void> {
    const now = Date.now();
    const previous: UnreachableStreak | null = JSON.parse(
      (await this.redis.hget(
        DedicatedServersService.UNREACHABLE_KEY,
        serverId,
      )) ?? "null",
    );

    // Pings run every minute. A longer gap means nothing was watching, not that
    // the server stayed down the whole time.
    const streak: UnreachableStreak =
      previous &&
      now - previous.last <= DedicatedServersService.UNREACHABLE_GAP_MS
        ? { ...previous, last: now }
        : { since: now, last: now, reported: false };

    await this.redis.hset(
      DedicatedServersService.UNREACHABLE_KEY,
      serverId,
      JSON.stringify(streak),
    );

    if (
      now - streak.since <
      DedicatedServersService.UNREACHABLE_ALERT_AFTER_MS
    ) {
      return;
    }

    if (server.connected) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: { connected: false, offline_at: new Date().toISOString() },
          },
          id: true,
        },
      });
    }

    if (
      streak.reported ||
      !server.enabled ||
      (await MarkDedicatedServerOffline.restartGraceRemaining(
        this.redis,
        serverId,
      )) > 0
    ) {
      return;
    }

    await this.notifications.send(
      "DedicatedServerRconStatus",
      {
        message: `Dedicated Server (${NotificationsService.escapeHtml(server.label || serverId)}) is not able to connect to the RCON.`,
        title: "Dedicated Server RCON Error",
        role: "administrator",
        entity_id: serverId,
      },
      undefined,
      DISCORD_COLORS.RED,
    );

    await this.redis.hset(
      DedicatedServersService.UNREACHABLE_KEY,
      serverId,
      JSON.stringify({ ...streak, reported: true }),
    );
  }

  public async restartDedicatedServer(serverId: string): Promise<void> {
    await this.expectRestart(serverId);
    await this.systemService.restartDeployment(
      this.getDedicatedServerDeploymentName(serverId),
      this.namespace,
    );
  }

  public async getAllDedicatedServerStats(): Promise<
    Array<{
      id: string;
      players: number;
      map?: string;
      last_ping?: string;
    }>
  > {
    try {
      const allServerData =
        (await this.redis.hgetall("dedicated-servers:stats")) ?? {};

      // The Player Management roster is pushed within a second of a join or
      // leave, so it wins over the minute-old RCON count whenever it exists.
      // It only refines servers the ping already lists, never adds any.
      const rosterCounts =
        (await this.redis.hgetall(ServerRosterService.COUNTS_KEY)) ?? {};

      if (Object.keys(allServerData).length === 0) {
        return [];
      }

      return Object.entries(allServerData)
        .map(([serverId, jsonData]) => {
          try {
            const data = JSON.parse(jsonData);
            const rosterCount = Number(rosterCounts[serverId]);

            return {
              id: serverId,
              map: data.map,
              lastPing: data.last_ping,
              players:
                rosterCounts[serverId] !== undefined &&
                Number.isInteger(rosterCount)
                  ? rosterCount
                  : parseInt(data.clients_human),
            };
          } catch (error) {
            this.logger.warn(
              `Failed to parse server data for ${serverId}:`,
              error,
            );
          }
        })
        .filter((result) => {
          return !!result;
        });
    } catch (error) {
      this.logger.error(
        "Failed to get dedicated server stats from Redis",
        error,
      );
      return [];
    }
  }

  private getDedicatedServerDeploymentName(serverId: string): string {
    return `dedicated-server-${serverId}`;
  }

  private async waitForPodReady(
    serverId: string,
    maxWaitTime: number = 60 * 1000,
  ): Promise<void> {
    const deploymentName = this.getDedicatedServerDeploymentName(serverId);
    const startTime = Date.now();

    this.logger.log(`[${serverId}] waiting for pod to be ready`);

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;

      const checkPodStatus = async () => {
        try {
          const deployment = await this.apps.readNamespacedDeployment({
            name: deploymentName,
            namespace: this.namespace,
          });

          const readyReplicas = deployment.status?.readyReplicas || 0;
          const desiredReplicas = deployment.spec?.replicas || 1;

          if (readyReplicas >= desiredReplicas) {
            resolve();
            return;
          }
        } catch (error) {
          this.logger.warn(
            `[${serverId}] error checking pod status: ${error.message}`,
          );
        }

        if (Date.now() - startTime >= maxWaitTime) {
          reject(
            new Error(
              `[${serverId}] timeout waiting for pod to be ready after ${maxWaitTime}ms`,
            ),
          );
          return;
        }

        timer = setTimeout(checkPodStatus, 5000);
      };

      void checkPodStatus();
    });
  }
}
