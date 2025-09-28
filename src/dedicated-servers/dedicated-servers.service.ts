import { Injectable, Logger } from "@nestjs/common";
import { CoreV1Api, AppsV1Api, KubeConfig } from "@kubernetes/client-node";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { EncryptionService } from "src/encryption/encryption.service";
import { HasuraService } from "src/hasura/hasura.service";
import { e_server_types_enum } from "../../generated";
import { RconService } from "src/rcon/rcon.service";
import { FetchError } from "@kubernetes/client-node";

@Injectable()
export class DedicatedServersService {
  private appConfig: AppConfig;
  private gameServerConfig: GameServersConfig;
  private readonly namespace: string;

  private core: CoreV1Api;
  private apps: AppsV1Api;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly encryption: EncryptionService,
    private readonly RconService: RconService,
  ) {
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
        api_password: true,
        rcon_password: true,
        connect_password: true,
        game_server_node: {
          id: true,
          pin_plugin_version: true,
          supports_cpu_pinning: true,
        },
        server_region: {
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

      const dedicatedServerDeploymentName = `dedicated-server-${serverId}`;
      await this.apps.createNamespacedDeployment({
        namespace: this.namespace,
        body: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: dedicatedServerDeploymentName,
          },
          spec: {
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
                // only enable host network if steam relay is enabled
                ...(steamRelay
                  ? {
                      hostNetwork: true,
                      dnsPolicy: "ClusterFirstWithHostNet",
                    }
                  : {}),
                nodeName: gameServerNodeId,
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
                      { containerPort: server.port, protocol: "TCP" },
                      { containerPort: server.port, protocol: "UDP" },
                      { containerPort: server.tv_port, protocol: "TCP" },
                      { containerPort: server.tv_port, protocol: "UDP" },
                    ],
                    env: [
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
                        value: `-maxplayers ${server.type === "Ranked" ? 13 : 32} +map de_dust2 +game_type ${this.getGameType(server.type)} +game_mode ${this.getGameMode(server.type)}${server.connect_password ? ` +sv_password ${server.connect_password}` : ""}`,
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
                ],
              },
            },
          },
        },
      });

      this.logger.verbose(`[${serverId}] create service for dedicated server`);

      await this.core.createNamespacedService({
        namespace: this.namespace,
        body: {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name: dedicatedServerDeploymentName,
          },
          spec: {
            type: "NodePort",
            ports: [
              {
                port: server.port,
                targetPort: server.port,
                nodePort: server.port,
                name: "rcon",
                protocol: "TCP",
              },
              {
                port: server.port,
                targetPort: server.port,
                nodePort: server.port,
                name: "game",
                protocol: "UDP",
              },
              {
                port: server.tv_port,
                targetPort: server.tv_port,
                nodePort: server.tv_port,
                name: "tv",
                protocol: "TCP",
              },
              {
                port: server.tv_port,
                targetPort: server.tv_port,
                nodePort: server.tv_port,
                name: "tv-udp",
                protocol: "UDP",
              },
            ],
            selector: {
              app: dedicatedServerDeploymentName,
            },
          },
        },
      });

      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              connected: true,
            },
          },
          id: true,
        },
      });

      setTimeout(() => {
        this.pingDedicatedServer(serverId);
      }, 10000);

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
    try {
      this.logger.log(`[${serverId}] removing dedicated server`);

      const dedicatedServerDeploymentName = `dedicated-server-${serverId}`;

      await this.core.deleteNamespacedService({
        namespace: this.namespace,
        name: dedicatedServerDeploymentName,
      });

      await this.apps.deleteNamespacedDeployment({
        namespace: this.namespace,
        name: dedicatedServerDeploymentName,
      });
    } catch (error: FetchError | any) {
      if (error instanceof FetchError && error.code === "404") {
        return;
      }
      this.logger.error(
        `[${serverId}] unable to remove dedicated server`,
        error?.response?.body?.message || error,
      );
    } finally {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: { id: serverId },
            _set: {
              connected: false,
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
      case "Custom":
        return 3;
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
      case "Custom":
        return 0;
    }
  }

  public async pingDedicatedServer(serverId: string): Promise<void> {
    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: { id: serverId },
        server_region: {
          steam_relay: true,
        },
      },
    });
    const rcon = await this.RconService.connect(serverId);
    if (!rcon) {
      return;
    }

    let steamId = null;
    if (server.server_region?.steam_relay) {
      const status = JSON.parse(await rcon.send("status_json"));
      steamId = status.server.steamid;
    }

    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: { id: serverId },
          _set: { steam_relay: steamId },
        },
        id: true,
      },
    });

    await this.RconService.disconnect(serverId);
  }
}
