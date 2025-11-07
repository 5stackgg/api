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

@Injectable()
export class DedicatedServersService {
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
        max_players: true,
        api_password: true,
        rcon_password: true,
        connect_password: true,
        game_server_node: {
          id: true,
          pin_plugin_version: true,
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

      let pluginImage = this.gameServerConfig.serverImage;

      const pinPluginVersion = server.game_server_node?.pin_plugin_version;

      if (pinPluginVersion) {
        pluginImage = this.gameServerConfig.serverImage.replace(
          /:.+$/,
          `:v${pinPluginVersion.toString()}`,
        );
      }

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
                dnsPolicy: "ClusterFirstWithHostNet",
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
                        name: "SERVER_TYPE",
                        value: server.type,
                      },
                      {
                        name: "INSTALL_5STACK_PLUGIN",
                        value: server.type === "Ranked" ? "true" : "false",
                      },
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
                        value: `-maxplayers ${server.type === "Ranked" ? 13 : server.max_players} +map de_dust2 +game_type ${this.getGameType(server.type)} +game_mode ${this.getGameMode(server.type)} +sv_skirmish_id ${this.getWarGameType(server.type)} ${server.connect_password ? ` +sv_password ${server.connect_password}` : ""} ${server.server_region.is_lan ? `+sv_lan 1` : ""}`,
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
                    ],
                    volumeMounts: [
                      {
                        name: `steamcmd-${sanitizedGameServerNodeId}`,
                        mountPath: "/serverdata/steamcmd",
                      },
                      {
                        name: `serverfiles-${sanitizedGameServerNodeId}`,
                        mountPath: "/serverdata/serverfiles",
                      },
                      {
                        name: `demos-${sanitizedGameServerNodeId}`,
                        mountPath: "/opt/demos",
                      },
                      {
                        name: `custom-plugins-${sanitizedGameServerNodeId}`,
                        mountPath: "/opt/custom-plugins",
                      },
                      {
                        name: `dedicated-server-data-${server.id}`,
                        mountPath: `/opt/custom-data`,
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
                    name: `serverfiles-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `serverfiles-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `demos-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `demos-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `custom-plugins-${sanitizedGameServerNodeId}`,
                    hostPath: {
                      path: `/opt/5stack/custom-plugins`,
                    },
                  },
                  {
                    name: `dedicated-server-data-${server.id}`,
                    hostPath: {
                      type: "DirectoryOrCreate",
                      path: `/opt/5stack/servers/${server.id}`,
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
      await this.removeDedicatedServer(serverId);

      this.logger.error(
        `[${serverId}] unable to create dedicated server`,
        error?.response?.body?.message || error,
      );

      return false;
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

  private getGameType(type: e_server_types_enum): number {
    switch (type) {
      case "Ranked":
      case "Casual":
      case "Competitive":
      case "Wingman":
        return 0;
      case "Deathmatch":
      case "ArmsRace":
        return 1;
      case "Retake":
      case "Custom":
        return 3;
    }
  }

  private getWarGameType(type: e_server_types_enum): number {
    switch (type) {
      case "Retake":
        return 12;
      default:
        return 0;
    }
  }

  private getGameMode(type: e_server_types_enum): number {
    switch (type) {
      case "Ranked":
      case "Competitive":
        return 1;
      case "ArmsRace":
      case "Casual":
        return 0;
      case "Wingman":
      case "Deathmatch":
        return 2;
      case "Retake":
      case "Custom":
        return 0;
    }
  }

  public async pingDedicatedServer(serverId: string): Promise<void> {
    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: { id: serverId },
        connected: true,
        steam_relay: true,
        server_region: {
          steam_relay: true,
        },
      },
    });
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return;
    }

    if (!server.connected) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: { pk_columns: { id: serverId }, _set: { connected: true } },
          id: true,
        },
      });
    }

    let steamId = null;
    const status = JSON.parse(await rcon.send("status_json"));

    const steamRelayeEnabled = server.server_region?.steam_relay;
    if (steamRelayeEnabled) {
      steamId = status.server.steamid;
    }

    await this.redis.hset(
      "dedicated-servers:stats",
      serverId,
      JSON.stringify({
        clients_human: status.server.clients_human,
        map: status.server.map || "unknown",
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

    await this.RconService.disconnect(serverId);
  }

  public async restartDedicatedServer(serverId: string): Promise<void> {
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
      const allServerData = await this.redis.hgetall("dedicated-servers:stats");

      if (!allServerData || Object.keys(allServerData).length === 0) {
        return [];
      }

      return Object.entries(allServerData)
        .map(([serverId, jsonData]) => {
          try {
            const data = JSON.parse(jsonData);

            return {
              id: serverId,
              map: data.map,
              lastPing: data.last_ping,
              players: parseInt(data.clients_human),
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

          if (Date.now() - startTime >= maxWaitTime) {
            reject(
              new Error(
                `[${serverId}] timeout waiting for pod to be ready after ${maxWaitTime}ms`,
              ),
            );
            return;
          }

          setTimeout(checkPodStatus, 5000);
        } catch (error) {
          this.logger.warn(
            `[${serverId}] error checking pod status: ${error.message}`,
          );

          if (Date.now() - startTime >= maxWaitTime) {
            reject(
              new Error(
                `[${serverId}] timeout waiting for pod to be ready after ${maxWaitTime}ms`,
              ),
            );
            return;
          }

          setTimeout(checkPodStatus, 5000);
        }
      };

      void checkPodStatus();
    });
  }
}
