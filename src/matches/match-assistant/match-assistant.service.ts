import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
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

@Injectable()
export class MatchAssistantService {
  private appConfig: AppConfig;
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;

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

  public async uploadBackupRound(matchId: string, round: number) {
    try {
      await this.command(matchId, `upload_backup_round ${round}`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send upload backup round to server`,
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

  public async isDedicatedServerAvailable(matchId: string): Promise<boolean> {
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

    return servers_by_pk.matches_aggregate.aggregate?.count === 0;
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

  public async assignServer(matchId: string): Promise<boolean> {
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

    if (
      game_server_nodes.length === 0 ||
      match.options.prefer_dedicated_server
    ) {
      const assigned = await this.assignDedicatedServer(match.id, match.region);

      if (assigned) {
        return true;
      }
    }

    return await this.assignOnDemandServer(matchId);
  }

  private async assignDedicatedServer(
    matchId: string,
    region: string,
  ): Promise<boolean> {
    const { servers } = await this.hasura.query({
      servers: {
        __args: {
          limit: 1,
          where: {
            connected: {
              _eq: true,
            },
            is_dedicated: {
              _eq: true,
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

    this.logger.debug(`[${matchId}] assigning on dedicated server`);

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
  }

  private async assignOnDemandServer(matchId: string): Promise<boolean> {
    this.logger.debug(`[${matchId}] assigning on demand server`);

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        region: true,
        password: true,
        server_id: true,
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

    const map = match.match_maps.at(0).map;

    return this.cache.lock(`get-on-demand-server:${match.region}`, async () => {
      if (match.server_id) {
        await this.stopOnDemandServer(matchId, match.server_id);
      }

      const kc = new KubeConfig();
      kc.loadFromDefault();

      const core = kc.makeApiClient(CoreV1Api);
      const batch = kc.makeApiClient(BatchV1Api);

      const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

      const { servers } = await this.hasura.query({
        servers: {
          __args: {
            where: {
              _and: [
                ...(match.region
                  ? [
                      {
                        game_server_node: {
                          region: {
                            _eq: match.region,
                          },
                        },
                      },
                    ]
                  : [
                      {
                        is_dedicated: {
                          _eq: false,
                        },
                      },
                    ]),
                {
                  reserved_by_match_id: {
                    _is_null: true,
                  },
                },
              ],
            },
          },
          id: true,
          host: true,
          port: true,
          tv_port: true,
          api_password: true,
          rcon_password: true,
          game_server_node_id: true,
        },
      });

      const server = servers.at(-1);

      if (!server) {
        await this.hasura.mutation({
          update_matches_by_pk: {
            __args: {
              pk_columns: {
                id: matchId,
              },
              _set: {
                status: "WaitingForServer",
              },
            },
            id: true,
          },
        });
        return;
      }

      try {
        this.logger.verbose(`[${matchId}] create job for on demand server`);

        const gameServerNodeId = server.game_server_node_id;

        await batch.createNamespacedJob(this.namespace, {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name: jobName,
          },
          spec: {
            template: {
              metadata: {
                name: jobName,
                labels: {
                  job: jobName,
                },
              },
              spec: {
                restartPolicy: "Never",
                nodeName: gameServerNodeId,
                containers: [
                  {
                    name: "server",
                    image: this.gameServerConfig.serverImage,
                    ports: [
                      { containerPort: server.port, protocol: "TCP" },
                      { containerPort: server.port, protocol: "UDP" },
                      { containerPort: server.tv_port, protocol: "TCP" },
                      { containerPort: server.tv_port, protocol: "UDP" },
                    ],
                    env: [
                      ...(!map.workshop_map_id
                        ? [{ name: "DEFAULT_MAP", value: map.name }]
                        : []),
                      { name: "SERVER_PORT", value: server.port.toString() },
                      { name: "TV_PORT", value: server.tv_port.toString() },
                      {
                        name: "RCON_PASSWORD",
                        value: await this.encryption.decrypt(
                          server.rcon_password,
                        ),
                      },
                      { name: "SERVER_PASSWORD", value: match.password },
                      { name: "EXTRA_GAME_PARAMS", value: "-maxplayers 13" },

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
                    ],
                    volumeMounts: [
                      {
                        name: `steamcmd-${gameServerNodeId}`,
                        mountPath: "/serverdata/steamcmd",
                      },
                      {
                        name: `serverfiles-${gameServerNodeId}`,
                        mountPath: "/serverdata/serverfiles",
                      },
                      {
                        name: `demos-${gameServerNodeId}`,
                        mountPath: "/opt/demos",
                      },
                      {
                        name: `custom-plugins-${gameServerNodeId}`,
                        mountPath: "/opt/custom-plugins",
                      },
                    ],
                  },
                ],
                // TODO - mabye we should use host paths, why do we want volumes?
                volumes: [
                  {
                    name: `steamcmd-${gameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `steamcmd-${gameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `serverfiles-${gameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `serverfiles-${gameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `demos-${gameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `demos-${gameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: `custom-plugins-${gameServerNodeId}`,
                    hostPath: {
                      path: `/opt/5stack/custom-plugins`,
                    },
                  },
                ],
              },
            },
            backoffLimit: 10,
          },
        });

        this.logger.verbose(`[${matchId}] create service for on demand server`);

        await core.createNamespacedService(this.namespace, {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name: jobName,
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
              job: jobName,
            },
          },
        });

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
      } catch (error) {
        await this.stopOnDemandServer(matchId, server.id);

        this.logger.error(
          `[${matchId}] unable to create on demand server`,
          error?.response?.body?.message || error,
        );

        await this.updateMatchStatus(matchId, "Scheduled");

        return false;
      }
    });
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

      const job = await batch.readNamespacedJob(jobName, this.namespace);
      if (job.body.status?.active) {
        const { body: pods } = await core.listNamespacedPod(
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `job-name=${jobName}`,
        );
        for (const pod of pods.items) {
          if (pod.status!.phase !== "Running") {
            return false;
          }
        }
      }

      const server = await this.getMatchServer(matchId);

      if (!server) {
        return false;
      }

      try {
        await this.rcon.connect(server.id);
      } catch (error) {
        this.logger.warn("unable to connect to server:", error.message);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(
        `unable to check server status`,
        error?.response?.body?.message || error,
      );
      return false;
    }
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
        jobId: `match:${matchId}:server`,
      },
    );
  }

  public async restartDedicatedServer(serverId: string) {
    this.logger.log(`[${serverId}] restarting server`);

    try {
      const rcon = await this.rcon.connect(serverId);
      await rcon.send("sv_cheats 1; quit");
    } catch (error) {
      this.logger.warn(`[${serverId}] unable to restart server`, error);
    }

    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: serverId,
          },
          _set: {
            reserved_by_match_id: null,
          },
        },
        __typename: true,
      },
    });
  }

  public async stopOnDemandServer(matchId: string, serverId: string) {
    this.logger.debug(`[${matchId}] stopping match server`);

    const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();

      const core = kc.makeApiClient(CoreV1Api);
      const batch = kc.makeApiClient(BatchV1Api);

      const { body: pods } = await core.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${jobName}`,
      );

      for (const pod of pods.items) {
        this.logger.verbose(`[${matchId}] remove pod`);
        await core
          .deleteNamespacedPod(pod.metadata!.name!, this.namespace)
          .catch((error) => {
            if (error?.statusCode !== 404) {
              throw error;
            }
          });
      }

      this.logger.verbose(`[${matchId}] remove job`);
      await batch
        .deleteNamespacedJob(jobName, this.namespace)
        .catch((error) => {
          if (error?.statusCode !== 404) {
            throw error;
          }
        });

      this.logger.verbose(`[${matchId}] remove service`);
      await core
        .deleteNamespacedService(jobName, this.namespace)
        .catch((error) => {
          if (error?.statusCode !== 404) {
            throw error;
          }
        });

      this.logger.verbose(`[${matchId}] stopped on demand server`);

      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: {
              id: serverId,
            },
            _set: {
              reserved_by_match_id: null,
            },
          },
          __typename: true,
        },
      });
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to stop on demand server`,
        error?.response?.body?.message || error,
      );
    }
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
      user,
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
      user,
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
      user,
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
      user,
    );

    return matches_by_pk.is_organizer;
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

    if (options.map) {
      options.maps = [options.map];
    }

    if (!map_pool_id && options.maps.length === 0) {
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
                            data: options.maps?.map((map_id) => {
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

  public async cancelMatchMakingDueToReadyCheck(confirmationId: string) {
    await this.queue.add(
      "CancelMatchMaking",
      {
        confirmationId,
      },
      {
        delay: 30 * 1000,
        jobId: `match-making:cancel:${confirmationId}`,
      },
    );
  }

  public async removeCancelMatchMakingDueToReadyCheck(confirmationId: string) {
    await this.queue.remove(`match-making:cancel:${confirmationId}`);
  }

  public async getNextPhase(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        server_id: true,
        region: true,
        options: {
          map_veto: true,
          region_veto: true,
          best_of: true,
        },
        match_maps: {
          id: true,
        },
      },
    });

    if (!match || !match.options) {
      throw Error("unable to find match");
    }

    let nextPhase: e_match_status_enum = "Live";
    if (
      (match.options.map_veto &&
        match.match_maps.length !== match.options.best_of) ||
      (!match.region && match.options.region_veto)
    ) {
      nextPhase = "Veto";
    }

    return nextPhase;
  }
}
