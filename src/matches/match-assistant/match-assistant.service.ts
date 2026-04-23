import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  Exec,
  V1Pod,
} from "@kubernetes/client-node";
import { RconService } from "../../rcon/rcon.service";
import { User } from "../../auth/types/User";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchJobs } from "../enums/MatchJobs";
import { ConfigService } from "@nestjs/config";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import {
  e_map_pool_types_enum,
  e_match_status_enum,
  e_match_types_enum,
  e_timeout_settings_enum,
} from "../../../generated";
import { CacheService } from "../../cache/cache.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { AppConfig } from "src/configs/types/AppConfig";
import { FailedToCreateOnDemandServer } from "../errors/FailedToCreateOnDemandServer";

@Injectable()
export class MatchAssistantService {
  private appConfig: AppConfig;
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;
  private static readonly REBOOTABLE_ON_DEMAND_STATUSES: readonly e_match_status_enum[] =
    [
      "Scheduled",
      "WaitingForCheckIn",
      "WaitingForServer",
      "Veto",
      "PickingPlayers",
      "Live",
    ];

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly encryption: EncryptionService,
    @InjectQueue(MatchQueues.MatchServers) private queue: Queue,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.namespace = this.gameServerConfig.namespace;
  }

  public static GetMatchServerJobId(matchId: string) {
    return `m-${matchId}`;
  }

  public async sendServerMatchId(matchId: string) {
    try {
      await this.command(matchId, `get_match`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send match to server`,
        error.message,
      );
    }
  }

  public async restoreMatchRound(matchId: string, round: number) {
    try {
      await this.command(matchId, `api_restore_round ${round}`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send restore round to server`,
        error.message,
      );
    }
  }

  public async knifeSwitch(matchId: string) {
    try {
      await this.command(matchId, `api_knife_switch`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send knife switch to the server`,
        error.message,
      );
    }
  }

  public async getMatchLineups(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        map_veto_picking_lineup_id: true,
        options: {
          type: true,
        },
        lineup_1_id: true,
        lineup_2_id: true,
        lineup_1: {
          id: true,
          name: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            discord_id: true,
            placeholder_name: true,
            player: {
              name: true,
              discord_id: true,
            },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            discord_id: true,
            placeholder_name: true,
            player: {
              name: true,
              discord_id: true,
            },
          },
        },
      },
    });

    if (!matches_by_pk) {
      return;
    }

    const lineup_players = [
      ...matches_by_pk.lineup_1.lineup_players,
      ...matches_by_pk.lineup_2.lineup_players,
    ];

    const match = matches_by_pk as typeof matches_by_pk & {
      lineup_players: typeof lineup_players;
    };

    match.lineup_players = lineup_players;

    return match;
  }

  public async getMatchServer(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        server: {
          id: true,
        },
      },
    });

    return matches_by_pk.server;
  }

  public async isDedicatedServerAvailable(
    matchId: string,
  ): Promise<string | undefined> {
    const server = await this.getMatchServer(matchId);

    if (!server) {
      throw Error("match has no server assigned");
    }

    const { servers_by_pk } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: server.id,
        },
        id: true,
        matches_aggregate: {
          __args: {
            where: {
              id: {
                _neq: matchId,
              },
              status: {
                _in: ["Live", "Veto"],
              },
            },
          },
          aggregate: {
            count: true,
          },
        },
      },
    });

    if (!servers_by_pk) {
      throw Error("unable to find server");
    }

    return (
      servers_by_pk.matches_aggregate.aggregate?.count === 0 && servers_by_pk.id
    );
  }

  public async updateMatchStatus(matchId: string, status: e_match_status_enum) {
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: matchId,
          },
          _set: {
            status: status,
          },
        },
        id: true,
      },
    });
  }

  public async assignServer(matchId: string, tries = 0): Promise<void> {
    if (tries === 0) {
      await this.setServerError(matchId, null);
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        region: true,
        options: {
          prefer_dedicated_server: true,
        },
      },
    });

    if (match.options.prefer_dedicated_server) {
      try {
        const assignedDedicated = await this.assignDedicatedServer(
          match.id,
          match.region,
        );

        if (assignedDedicated) {
          await this.startMatch(matchId);
          return;
        }
      } catch (error) {
        this.logger.error(
          `[${matchId}] unable to assign dedicated server`,
          error,
        );
      }
    }

    try {
      const isAssignedOnDemand = await this.assignOnDemandServer(matchId);
      if (isAssignedOnDemand) {
        await this.startMatch(matchId);
        return;
      }
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to assign on demand server`,
        error,
      );
      if (error instanceof FailedToCreateOnDemandServer) {
        if (tries >= 10) {
          this.logger.error(
            `[${matchId}] max retries reached for server assignment`,
          );
          await this.updateMatchStatus(matchId, "WaitingForServer");
          return;
        }
        setTimeout(async () => {
          this.logger.log(`[${matchId}] try retry assign server....`);
          await this.assignServer(matchId, ++tries);
        }, tries * 1000);
        return;
      }
    }

    // we already checked above, so we can skip trying to assign again
    if (match.options.prefer_dedicated_server) {
      this.logger.log(
        `[${matchId}] unable to assign dedicated server, trying on demand`,
      );
      await this.updateMatchStatus(match.id, "WaitingForServer");
      return;
    }

    try {
      if (await this.assignDedicatedServer(match.id, match.region)) {
        await this.startMatch(matchId);
        return;
      }
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to assign dedicated server`,
        error,
      );
    }

    this.logger.log(
      `[${matchId}] unable to assign dedicated server, updating match status to waiting for server`,
    );

    await this.updateMatchStatus(match.id, "WaitingForServer");
  }

  public async rebootOnDemandServer(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        status: true,
        server_id: true,
        server: {
          id: true,
          game_server_node_id: true,
        },
      },
    });

    if (!match) {
      throw Error("match not found");
    }

    if (!match.server_id || !match.server?.id) {
      throw Error("match has no assigned server");
    }

    if (
      !MatchAssistantService.REBOOTABLE_ON_DEMAND_STATUSES.includes(
        match.status,
      )
    ) {
      throw Error("match server cannot be rebooted in the current match state");
    }

    if (!match.server.game_server_node_id) {
      throw Error("only on demand servers can be rebooted");
    }

    await this.setServerError(matchId, null);

    const rebooted = await this.assignOnDemandServer(matchId, {
      preserveMatchStatus: true,
    });

    if (!rebooted) {
      throw Error("no on demand servers are available to reboot this match");
    }

    await this.delayCheckOnDemandServer(matchId);
  }

  private async startMatch(matchId: string) {
    await this.setServerError(matchId, null);

    await this.updateMatchStatus(matchId, "Live");

    await this.sendServerMatchId(matchId);
  }

  public async reserveDedicatedServer(matchId: string) {
    const serverId = await this.isDedicatedServerAvailable(matchId);
    if (!serverId) {
      this.logger.warn(
        `[${matchId}] another match is currently live, moving back to scheduled`,
      );
      await this.updateMatchStatus(matchId, "WaitingForServer");

      return;
    }

    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: serverId,
          },
          _set: {
            reserved_by_match_id: matchId,
          },
        },
        __typename: true,
      },
    });

    await this.startMatch(matchId);
  }

  private async assignDedicatedServer(
    matchId: string,
    region: string,
  ): Promise<boolean> {
    return this.cache.lock(
      `assign-dedicated-server:${region}`,
      async () => {
        const { servers } = await this.hasura.query({
          servers: {
            __args: {
              limit: 1,
              where: {
                connected: {
                  _eq: true,
                },
                enabled: {
                  _eq: true,
                },
                is_dedicated: {
                  _eq: true,
                },
                type: {
                  _eq: "Ranked",
                },
                reserved_by_match_id: {
                  _is_null: true,
                },
                region: {
                  _eq: region,
                },
              },
            },
            id: true,
          },
        });

        const server = servers.at(0);

        if (!server) {
          return false;
        }

        this.logger.log(`[${matchId}] assigning on dedicated server`);

        await this.hasura.mutation({
          update_matches_by_pk: {
            __args: {
              pk_columns: {
                id: matchId,
              },
              _set: {
                server_id: server.id,
              },
            },
            __typename: true,
          },
        });

        await this.hasura.mutation({
          update_servers_by_pk: {
            __args: {
              pk_columns: {
                id: server.id,
              },
              _set: {
                reserved_by_match_id: matchId,
              },
            },
            __typename: true,
          },
        });

        return true;
      },
      10,
    );
  }

  private async assignOnDemandServer(
    matchId: string,
    options?: {
      preserveMatchStatus?: boolean;
    },
  ): Promise<boolean> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        region: true,
        password: true,
        server_id: true,
        max_players_per_lineup: true,
        match_maps: {
          __args: {
            order_by: [
              {
                order: "asc",
              },
            ],
          },
          map: {
            name: true,
            workshop_map_id: true,
          },
          order: true,
        },
      },
    });

    if (!match) {
      throw Error("unable to find match");
    }

    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            status: {
              _eq: "Online",
            },
            enabled: {
              _eq: true,
            },
            region: {
              _eq: match.region,
            },
          },
        },
        id: true,
      },
    });

    if (game_server_nodes.length === 0) {
      return false;
    }

    const map = match.match_maps.at(0).map;

    return this.cache.lock(
      `get-on-demand-server:${match.region}`,
      async () => {
        this.logger.log(`[${matchId}] assigning on demand server`);

        // Always tear down any existing k8s job for this match before creating
        // a new one. Covers three cases: (a) the match still has server_id set,
        // (b) server_id was cleared but a stale job is left over from a prior
        // assignment, (c) delete propagation is slow — the wait-until-gone loop
        // inside stopOnDemandServer(remove=true) ensures the name is free.
        await this.stopOnDemandServer(matchId, true);

        const kc = new KubeConfig();
        kc.loadFromDefault();

        const batch = kc.makeApiClient(BatchV1Api);

        const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

        const { servers } = await this.hasura.query({
          servers: {
            __args: {
              limit: 1,
              order_by: [
                {
                  updated_at: "asc",
                },
              ],
              where: {
                type: {
                  _eq: "Ranked",
                },
                enabled: {
                  _eq: true,
                },
                is_dedicated: {
                  _eq: false,
                },
                reserved_by_match_id: {
                  _is_null: true,
                },
                game_server_node: {
                  _and: [
                    {
                      enabled: {
                        _eq: true,
                      },
                      status: {
                        _eq: "Online",
                      },
                    },
                    ...(match.region
                      ? [
                          {
                            region: {
                              _eq: match.region,
                            },
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
            id: true,
            label: true,
            host: true,
            port: true,
            tv_port: true,
            api_password: true,
            rcon_password: true,
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

        const server = servers.at(-1);

        if (!server) {
          if (!options?.preserveMatchStatus) {
            await this.updateMatchStatus(matchId, "WaitingForServer");
          }
          return false;
        }

        try {
          this.logger.verbose(
            `[${matchId}] create job for on demand server (${server.label})`,
          );

          await this.hasura.mutation({
            update_servers_by_pk: {
              __args: {
                pk_columns: {
                  id: server.id,
                },
                _set: {
                  connected: false,
                  reserved_by_match_id: matchId,
                },
              },
              __typename: true,
            },
          });

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

          const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(
            ".",
            "-",
          );

          let pluginImage = this.gameServerConfig.serverImage;

          const pinPluginVersion = server.game_server_node?.pin_plugin_version;

          if (pinPluginVersion) {
            pluginImage = this.gameServerConfig.serverImage.replace(
              /:.+$/,
              `:v${pinPluginVersion.toString()}`,
            );
          }

          await batch.createNamespacedJob({
            namespace: this.namespace,
            body: {
              apiVersion: "batch/v1",
              kind: "Job",
              metadata: {
                name: jobName,
              },
              spec: {
                ttlSecondsAfterFinished: 60 * 60 * 24,
                template: {
                  metadata: {
                    name: jobName,
                    labels: {
                      job: jobName,
                    },
                  },
                  spec: {
                    restartPolicy: "Never",
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
                          { containerPort: server.port, protocol: "TCP" },
                          { containerPort: server.port, protocol: "UDP" },
                          { containerPort: server.tv_port, protocol: "TCP" },
                          { containerPort: server.tv_port, protocol: "UDP" },
                        ],
                        env: [
                          {
                            name: "GAME_NODE_SERVER",
                            value: "true",
                          },
                          {
                            name: "SERVER_PORT",
                            value: server.port.toString(),
                          },
                          { name: "TV_PORT", value: server.tv_port.toString() },
                          {
                            name: "RCON_PASSWORD",
                            value: await this.encryption.decrypt(
                              server.rcon_password,
                            ),
                          },
                          {
                            name: "EXTRA_GAME_PARAMS",
                            value: `-maxplayers ${match.max_players_per_lineup * 2 + 3} ${map.workshop_map_id ? `+map de_inferno` : `+map ${map.name}`} +sv_password ${match.password} ${server.server_region.is_lan ? `+sv_lan 1` : ""}`,
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
                    // TODO - should use host paths, why do we want volumes?
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
                backoffLimit: 10,
              },
            },
          });

          this.logger.verbose(
            `[${matchId}] create service for on demand server`,
          );

          await this.hasura.mutation({
            update_matches_by_pk: {
              __args: {
                pk_columns: {
                  id: matchId,
                },
                _set: {
                  server_id: server.id,
                },
              },
              __typename: true,
            },
          });

          return true;
        } catch (error) {
          await this.stopOnDemandServer(matchId, true);

          this.logger.error(
            `[${matchId}] unable to create on demand server`,
            error?.response?.body?.message || error,
          );

          throw new FailedToCreateOnDemandServer();
        }
      },
      10,
    );
  }

  public async isOnDemandServerRunning(matchId: string) {
    const server = await this.getMatchServer(matchId);

    if (!server) {
      return;
    }

    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();

      const core = kc.makeApiClient(CoreV1Api);
      const batch = kc.makeApiClient(BatchV1Api);

      const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

      const job = await batch.readNamespacedJob({
        name: jobName,
        namespace: this.namespace,
      });
      if (job.status?.active) {
        const podList = await core.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: `job-name=${jobName}`,
        });
        for (const pod of podList.items) {
          if (pod.status!.phase !== "Running") {
            const podError = await this.derivePodError(core, pod);
            await this.setServerError(matchId, podError);
            return false;
          }
        }
      }

      const server = await this.getMatchServer(matchId);

      if (!server) {
        return false;
      }

      const rcon = await this.rcon.connect(server.id);
      if (!rcon) {
        return false;
      }

      await this.rcon.disconnect(server.id);

      await this.setServerError(matchId, null);

      return true;
    } catch (error) {
      const message = error?.response?.body?.message || error?.message || null;
      this.logger.warn(`unable to check server status`, message || error);
      if (message) {
        await this.setServerError(matchId, message);
      }
      return false;
    }
  }

  private async derivePodError(
    core: CoreV1Api,
    pod: V1Pod,
  ): Promise<string | null> {
    const scheduled = pod.status?.conditions?.find(
      (condition) => condition.type === "PodScheduled",
    );
    if (
      scheduled?.status === "False" &&
      (scheduled.reason || scheduled.message)
    ) {
      return [scheduled.reason, scheduled.message].filter(Boolean).join(": ");
    }

    const waiting = pod.status?.containerStatuses?.find(
      (status) => status.state?.waiting?.reason,
    )?.state?.waiting;
    if (waiting?.reason && waiting.reason !== "ContainerCreating") {
      return [waiting.reason, waiting.message].filter(Boolean).join(": ");
    }

    const podName = pod.metadata?.name;
    if (podName) {
      try {
        const events = await core.listNamespacedEvent({
          namespace: this.namespace,
          fieldSelector: `involvedObject.name=${podName},involvedObject.kind=Pod`,
        });
        const latestWarning = events.items
          .filter((event) => event.type === "Warning")
          .sort((a, b) => {
            const at = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
            const bt = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
            return bt - at;
          })[0];
        if (latestWarning?.reason || latestWarning?.message) {
          return [latestWarning.reason, latestWarning.message]
            .filter(Boolean)
            .join(": ");
        }
      } catch (error) {
        this.logger.warn(
          `unable to list pod events`,
          error?.response?.body?.message || error?.message || error,
        );
      }
    }

    return null;
  }

  private async setServerError(matchId: string, message: string | null) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        server_error: true,
      },
    });

    if ((matches_by_pk?.server_error ?? null) === (message ?? null)) {
      return;
    }

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: matchId,
          },
          _set: {
            server_error: message,
          },
        },
        __typename: true,
      },
    });
  }

  public async delayCheckOnDemandServer(matchId: string) {
    await this.queue.add(
      MatchJobs.CheckOnDemandServerJob,
      {
        matchId,
      },
      {
        delay: 10 * 1000,
        attempts: 1,
        removeOnFail: true,
        removeOnComplete: true,
        jobId: `match.${matchId}.server`,
      },
    );
  }

  public async stopOnDemandServer(matchId: string, remove = false) {
    this.logger.log(`[${matchId}] stopping match servers`);

    const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();

      const core = kc.makeApiClient(CoreV1Api);
      const batch = kc.makeApiClient(BatchV1Api);

      const podList = await core.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name=${jobName}`,
      });

      for (const pod of podList.items) {
        this.logger.verbose(`[${matchId}] remove pod`);

        if (!remove) {
          // Only Running pods accept exec; anything else (Succeeded / Failed /
          // Pending) responds 400 to the upgrade request. Skip those — there's
          // nothing to signal.
          if (pod.status?.phase !== "Running") {
            continue;
          }
          try {
            await new Exec(kc).exec(
              this.namespace,
              pod.metadata!.name!,
              pod.spec!.containers?.at(0)?.name,
              ["kill", "-SIGUSR1", "1"],
              process.stdout,
              process.stderr,
              process.stdin,
              false,
            );
          } catch (error) {
            this.logger.warn(
              `[${matchId}] graceful shutdown signal failed: ${error?.message || "exec error"}`,
            );
          }
          continue;
        }
        await core
          .deleteNamespacedPod({
            name: pod.metadata!.name!,
            namespace: this.namespace,
            gracePeriodSeconds: 0,
          })
          .catch((error) => {
            if (error.code.toString() !== "404") {
              throw error;
            }
          });
      }

      if (!remove) {
        return;
      }

      this.logger.verbose(`[${matchId}] remove job`);

      await batch
        .deleteNamespacedJob({
          name: jobName,
          namespace: this.namespace,
          propagationPolicy: "Background",
          gracePeriodSeconds: 0,
        })
        .catch((error) => {
          if (error.code.toString() !== "404") {
            throw error;
          }
        });

      // Wait for the job to be fully gone from the k8s API before returning.
      // Without this, a subsequent createNamespacedJob with the same name races
      // against delete propagation and gets HTTP 409 AlreadyExists.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await batch.readNamespacedJob({
            name: jobName,
            namespace: this.namespace,
          });
        } catch (error) {
          if (error.code?.toString() === "404") {
            break;
          }
          throw error;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      this.logger.verbose(`[${matchId}] stopped on demand server`);
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to stop on demand server`,
        error?.response?.body?.message || error,
      );
    }

    await this.hasura.mutation({
      update_servers: {
        __args: {
          where: {
            reserved_by_match_id: {
              _eq: matchId,
            },
          },
          _set: {
            connected: false,
            reserved_by_match_id: null,
          },
        },
        __typename: true,
      },
    });

    await this.setServerError(matchId, null);
  }

  public async getAvailableMaps(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        options: {
          map_pool: {
            maps: {
              id: true,
              name: true,
            },
          },
        },
        map_veto_picks: {
          __args: {
            where: {
              _or: [
                {
                  type: {
                    _eq: "Ban",
                  },
                },
                {
                  type: {
                    _eq: "Pick",
                  },
                },
              ],
            },
          },
          map_id: true,
        },
      },
    });

    if (!matches_by_pk?.options?.map_pool) {
      throw Error("unable to find match maps");
    }

    return matches_by_pk.options.map_pool.maps.filter((map) => {
      return !matches_by_pk.map_veto_picks.find((veto) => {
        return veto.map_id === map.id;
      });
    });
  }

  private async command(matchId: string, command: Array<string> | string) {
    const server = await this.getMatchServer(matchId);
    if (!server) {
      this.logger.warn(`[${matchId}] server was not assigned to this match`);
      return;
    }
    const rcon = await this.rcon.connect(server.id);

    if (!rcon) {
      return;
    }

    return await rcon.send(
      Array.isArray(command) ? command.join(";") : command,
    );
  }

  public async canSchedule(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          can_schedule: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.can_schedule;
  }

  public async canCancel(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          can_cancel: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.can_cancel;
  }

  public async canStart(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          can_start: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.can_start;
  }

  public async isOrganizer(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          is_organizer: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.is_organizer;
  }

  public async canReassignWinner(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: { id: matchId },
          can_reassign_winner: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk?.can_reassign_winner ?? false;
  }

  public async createMatchBasedOnType(
    matchType: e_match_types_enum,
    mapPoolType: e_map_pool_types_enum,
    options: {
      mr: number;
      best_of: number;
      knife: boolean;
      map?: string;
      overtime: boolean;
      timeout_setting?: e_timeout_settings_enum;
      region?: string;
      maps?: Array<string>;
    },
  ) {
    let map_pool_id;

    if (!options.maps) {
      options.maps = [];
    }

    if (options.map) {
      options.maps = [options.map];
    }

    if (options.maps.length === 0) {
      const { map_pools } = await this.hasura.query({
        map_pools: {
          __args: {
            where: {
              type: {
                _eq: mapPoolType,
              },
            },
          },
          id: true,
        },
      });

      map_pool_id = map_pools.at(0).id;
    }

    const { insert_matches_one } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            region: options.region,
            options: {
              data: {
                ...(map_pool_id
                  ? {
                      map_pool_id: map_pool_id,
                    }
                  : {}),
                ...(map_pool_id
                  ? {}
                  : {
                      map_pool: {
                        data: {
                          type: "Custom",
                          maps: {
                            data: options.maps.map((map_id) => {
                              return {
                                id: map_id,
                              };
                            }),
                          },
                        },
                      },
                    }),
                map_veto: map_pool_id !== null || options.maps.length > 1,
                mr: options.mr,
                type: matchType,
                best_of: options.best_of,
                overtime: options.overtime,
                knife_round: options.knife,
                region_veto: options.region ? false : true,
                ...(options.timeout_setting && {
                  timeout_setting: options.timeout_setting,
                }),
              },
            },
          },
        },
        id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });

    return insert_matches_one;
  }
}
