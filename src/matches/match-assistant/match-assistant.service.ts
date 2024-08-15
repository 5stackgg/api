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

@Injectable()
export class MatchAssistantService {
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;
  private readonly SERVER_PORT_START: number;
  private readonly SERVER_PORT_END: number;

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly serverAuth: ServerAuthService,
    @InjectQueue(MatchQueues.MatchServers) private queue: Queue,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");

    this.namespace = this.gameServerConfig.namespace;

    const [start, end] = this.gameServerConfig.portRange;

    this.SERVER_PORT_START = parseInt(start);
    this.SERVER_PORT_END = parseInt(end);
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
          is_on_demand: true,
          rcon_password: true,
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

    const serverId: string = uuidv4();

    const core = kc.makeApiClient(CoreV1Api);
    const batch = kc.makeApiClient(BatchV1Api);

    const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

    try {
      this.logger.verbose(`[${matchId}] create job for on demand server`);

      const { tvPort, gamePort } = await this.getServerPorts();

      const { insert_servers_one: server } = await this.hasura.mutation({
        insert_servers_one: {
          __args: {
            object: {
              id: serverId,
              is_on_demand: true,
              port: gamePort,
              tv_port: tvPort,
              label: `${jobName}`,
              host: this.gameServerConfig.serverDomain,
              rcon_password: this.gameServerConfig.defaultRconPassword,
            },
          },
          id: true,
          api_password: true,
        },
      });

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
              containers: [
                {
                  name: "server",
                  image: this.gameServerConfig.serverImage,
                  ports: [
                    { containerPort: gamePort, protocol: "TCP" },
                    { containerPort: gamePort, protocol: "UDP" },
                    { containerPort: tvPort, protocol: "TCP" },
                    { containerPort: tvPort, protocol: "UDP" },
                  ],
                  env: [
                    {
                      name: "GAME_PARAMS",
                      value: `-ip 0.0.0.0 -port ${gamePort} +tv_port ${tvPort} -dedicated -dev +map de_inferno -usercon +rcon_password ${
                        this.gameServerConfig.defaultRconPassword
                      }
                         +sv_password ${match.password} -authkey ${
                           this.config.get<SteamConfig>("steam").steamApiKey
                         }
                      +sv_setsteamaccount ${
                        this.config.get<SteamConfig>("steam").steamAccount
                      }
                       -maxplayers 13`,
                    },
                    { name: "SERVER_ID", value: server.id },
                    { name: "SERVER_API_PASSWORD", value: server.api_password },
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
              port: gamePort,
              targetPort: gamePort,
              nodePort: gamePort,
              name: "rcon",
              protocol: "TCP",
            },
            {
              port: gamePort,
              targetPort: gamePort,
              nodePort: gamePort,
              name: "game",
              protocol: "UDP",
            },
            {
              port: tvPort,
              targetPort: tvPort,
              nodePort: tvPort,
              name: "tv",
              protocol: "TCP",
            },
            {
              port: tvPort,
              targetPort: tvPort,
              nodePort: tvPort,
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
              server_id: serverId,
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
        error?.response?.body?.message || error.response,
      );

      await this.updateMatchStatus(matchId, "Scheduled");

      return false;
    }
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
        delay: 10,
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

      const server = await this.getMatchServer(matchId);

      if (!server || !server.is_on_demand) {
        return;
      }

      await this.hasura.mutation({
        delete_servers_by_pk: {
          __args: {
            id: server.id,
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

  private async getServerPorts() {
    const { servers } = await this.hasura.query({
      servers: {
        __args: {
          where: {
            is_on_demand: {
              _eq: true,
            },
            matches: {
              status: {
                _nin: [
                  "Scheduled",
                  "WaitingForCheckIn",
                  "Tie",
                  "Forfeit",
                  "Canceled",
                  "Finished",
                ],
              },
            },
          },
        },
        id: true,
        port: true,
        tv_port: true,
      },
    });

    const portsTaken = servers.flatMap((server) => {
      const ports = [server.port];

      if (server.tv_port) {
        ports.push(server.tv_port);
      }

      return ports;
    });

    const availablePorts = new Array(
      this.SERVER_PORT_END - this.SERVER_PORT_START + 1,
    ).fill(true);

    for (const port of portsTaken) {
      availablePorts[port + this.SERVER_PORT_START] = false;
    }

    const availableIndices = this.getAvailablePortIndices(availablePorts);

    if (availableIndices.length < 2) {
      throw new Error("not enough available ports.");
    }

    const gamePort =
      availableIndices[Math.floor(Math.random() * availableIndices.length)];
    availablePorts[gamePort] = false;

    const availableIndicesAfterFirstSelection =
      this.getAvailablePortIndices(availablePorts);

    if (availableIndicesAfterFirstSelection.length < 1) {
      throw new Error("not enough available ports after the first selection.");
    }

    const tvPort =
      availableIndicesAfterFirstSelection[
        Math.floor(Math.random() * availableIndicesAfterFirstSelection.length)
      ];
    availablePorts[tvPort] = false;

    return {
      tvPort: tvPort + this.SERVER_PORT_START,
      gamePort: gamePort + this.SERVER_PORT_START,
    };
  }

  private getAvailablePortIndices(
    ports: Array<{
      isAvailable: boolean;
    }>,
  ) {
    return ports.reduce((acc, isAvailable, index) => {
      if (isAvailable) {
        acc.push(index);
      }
      return acc;
    }, []);
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
