import { v4 as uuidv4 } from "uuid";
import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { RconService } from "../../rcon/rcon.service";
import { User } from "../../auth/types/User";
import { ServerAuthService } from "../server-auth/server-auth.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchJobs } from "../enums/MatchJobs";
import { ConfigService } from "@nestjs/config";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { SteamConfig } from "../../configs/types/SteamConfig";
import { e_match_status_enum } from "../../../generated";
import { CacheService } from "../../cache/cache.service";
import { EncryptionService } from "../../encryption/encryption.service";

@Injectable()
export class MatchAssistantService {
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly serverAuth: ServerAuthService,
    private readonly encryption: EncryptionService,
    @InjectQueue(MatchQueues.MatchServers) private queue: Queue,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.namespace = this.gameServerConfig.namespace;
  }

  public static GetMatchServerJobId(matchId: string) {
    return `cs-match-${matchId}`;
  }

  public async sendServerMatchId(matchId: string) {
    try {
      await this.serverAuth.addMatchById(matchId);
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
        veto_picking_lineup_id: true,
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
        id: true,
        server: {
          id: true,
          host: true,
          port: true,
          rcon_password: true,
          game_server_node_id: true,
        },
      },
    });

    return matches_by_pk?.server || undefined;
  }

  public async isMatchServerAvailable(matchId: string): Promise<boolean> {
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

  public async assignOnDemandServer(matchId: string): Promise<boolean> {
    this.logger.debug(`[${matchId}] assigning on demand server`);
    return this.cache.lock("get-on-demand-server", async () => {
      await this.stopOnDemandServer(matchId);

      const { matches_by_pk: match } = await this.hasura.query({
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          password: true,
        },
      });

      if (!match) {
        throw Error("unable to find match");
      }

      const kc = new KubeConfig();
      kc.loadFromDefault();

      const core = kc.makeApiClient(CoreV1Api);
      const batch = kc.makeApiClient(BatchV1Api);

      const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

      try {
        this.logger.verbose(`[${matchId}] create job for on demand server`);

        // TODO - atomic lock
        const { servers } = await this.hasura.query({
          servers: {
            __args: {
              where: {
                _and: [
                  {
                    game_server_node_id: {
                      _is_null: false,
                    },
                  },
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
          // TODO
          throw Error("no available servers");
        }

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
                affinity: {
                  nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                      nodeSelectorTerms: [
                        {
                          matchExpressions: [
                            {
                              key: "5stack-id",
                              operator: "In",
                              values: [server.game_server_node_id],
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
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
                      {
                        name: "GAME_PARAMS",
                        value: `-ip 0.0.0.0 -port ${server.port} +tv_port ${server.tv_port} -dedicated -dev +map de_inferno -usercon +rcon_password ${await this.encryption.decrypt(server.rcon_password)}
                         +sv_password ${match.password} -authkey ${
                           this.config.get<SteamConfig>("steam").steamApiKey
                         }
                      +sv_setsteamaccount ${
                        this.config.get<SteamConfig>("steam").steamAccount
                      }
                       -maxplayers 13`,
                      },
                      { name: "SERVER_ID", value: server.id },
                      {
                        name: "SERVER_API_PASSWORD",
                        value: server.api_password,
                      },
                    ],
                    volumeMounts: [
                      {
                        name: `steamcmd-${this.namespace}`,
                        mountPath: "serverdata/steamcmd",
                      },
                      {
                        name: `serverfiles-${this.namespace}`,
                        mountPath: "/serverdata/serverfiles",
                      },
                      {
                        name: `demos-${this.namespace}`,
                        mountPath: "/opt/demos",
                      },
                    ],
                  },
                ],
                volumes: [
                  {
                    name: `steamcmd-${this.namespace}`,
                    persistentVolumeClaim: {
                      claimName: `steamcmd-${this.namespace}-claim`,
                    },
                  },
                  {
                    name: `serverfiles-${this.namespace}`,
                    persistentVolumeClaim: {
                      claimName: `serverfiles-${this.namespace}-claim`,
                    },
                  },
                  {
                    name: `demos-${this.namespace}`,
                    persistentVolumeClaim: {
                      claimName: `demos-${this.namespace}-claim`,
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
        await this.stopOnDemandServer(matchId);

        this.logger.error(
          `[${matchId}] unable to create on demand server`,
          error,
        );

        await this.updateMatchStatus(matchId, "Scheduled");

        return false;
      }
    });
  }

  public async isOnDemandServerRunning(matchId: string) {
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

  public async stopMatch(matchId: string) {
    const server = await this.getMatchServer(matchId);

    if (!server) {
      return;
    }

    await this.serverAuth.removeServer(server.id);
    await this.stopOnDemandServer(matchId);
  }

  public async stopOnDemandServer(matchId: string) {
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
        update_matches_by_pk: {
          __args: {
            pk_columns: {
              id: matchId,
            },
            _set: {
              server_id: null,
            },
          },
          __typename: true,
        },
      });

      await this.hasura.mutation({
        update_servers: {
          __args: {
            where: {
              reserved_by_match_id: {
                _eq: matchId,
              },
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
        veto_picks: {
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
      return !matches_by_pk.veto_picks.find((veto) => {
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
}
