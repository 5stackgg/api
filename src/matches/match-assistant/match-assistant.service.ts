import { v4 as uuidv4 } from "uuid";
import { Injectable } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import {
  e_match_status_enum,
  e_veto_pick_types_enum,
} from "../../../generated/zeus";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { RconService } from "../../rcon/rcon.service";
import { User } from "../../auth/types/User";
import { ServerAuthService } from "../server-auth/server-auth.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchJobs } from "../enums/MatchJobs";

@Injectable()
export class MatchAssistantService {
  private readonly namespace: string;
  private readonly SERVER_PORT_START: number;
  private readonly SERVER_PORT_END: number;

  constructor(
    private readonly rcon: RconService,
    private readonly hasura: HasuraService,
    private readonly serverAuth: ServerAuthService,
    @InjectQueue(MatchQueues.MatchServers) private queue: Queue
  ) {
    this.namespace = process.env.SERVER_NAMESPACE as string;

    const [start, end] = (process.env.SERVER_PORT_RANGE || "30000:30085").split(
      ":"
    );

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
      console.warn(
        `[${matchId}] unable to send match to server`,
        error.message
      );
    }
  }

  public async restoreMatchRound(matchId: string, round: number) {
    try {
      await this.command(matchId, `api_restore_round ${round}`);
    } catch (error) {
      console.warn(
        `[${matchId}] unable to send restore round to server`,
        error.message
      );
    }
  }

  public async getMatchLineups(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          type: true,
          lineup_1_id: true,
          lineup_2_id: true,
          veto_picking_lineup_id: true,
          lineups: [
            {},
            {
              id: true,
              name: true,
              lineup_players: [
                {},
                {
                  captain: true,
                  steam_id: true,
                  discord_id: true,
                  placeholder_name: true,
                  player: {
                    name: true,
                    discord_id: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    if (!matches_by_pk) {
      return;
    }

    const lineup_1 = matches_by_pk.lineups.find((lineup) => {
      return lineup.id === matches_by_pk.lineup_1_id;
    });

    const lineup_2 = matches_by_pk.lineups.find((lineup) => {
      return lineup.id === matches_by_pk.lineup_2_id;
    });

    const lineup_players = [].concat(
      ...matches_by_pk.lineups.map((lineup) => lineup.lineup_players)
    );

    const match = matches_by_pk as typeof matches_by_pk & {
      lineup_1: typeof lineup_1;
      lineup_2: typeof lineup_2;
      lineup_players: typeof lineup_players;
    };

    match.lineup_1 = lineup_1;
    match.lineup_2 = lineup_2;
    match.lineup_players = lineup_players;

    return match;
  }

  public async getMatchServer(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          id: true,
          server: {
            id: true,
            host: true,
            port: true,
            on_demand: true,
            rcon_password: true,
          },
        },
      ],
    });

    return matches_by_pk?.server || undefined;
  }

  public async isMatchServerAvailable(matchId: string): Promise<boolean> {
    const server = await this.getMatchServer(matchId);

    if (!server) {
      throw Error("match has no server assigned");
    }

    const { servers_by_pk } = await this.hasura.query({
      servers_by_pk: [
        {
          id: server.id,
        },
        {
          id: true,
          matches_aggregate: [
            {
              where: {
                id: {
                  _neq: matchId,
                },
                status: {
                  _in: [e_match_status_enum.Live, e_match_status_enum.Veto],
                },
              },
            },
            {
              aggregate: {
                count: [{}, true],
              },
            },
          ],
        },
      ],
    });

    if (!servers_by_pk) {
      throw Error("unable to find server");
    }

    return servers_by_pk.matches_aggregate.aggregate?.count === 0;
  }

  public async updateMatchStatus(matchId: string, status: e_match_status_enum) {
    await this.hasura.mutation({
      update_matches_by_pk: [
        {
          pk_columns: {
            id: matchId,
          },
          _set: {
            status: status,
          },
        },
        {
          id: true,
        },
      ],
    });
  }

  public async assignOnDemandServer(matchId: string): Promise<boolean> {
    console.info(`[${matchId}] assigning on demand server`);
    await this.stopOnDemandServer(matchId);

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          password: true,
        },
      ],
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
      console.trace(`[${matchId}] create job for on demand server`);

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
                  image: process.env.SERVER_IMAGE,
                  ports: [
                    { containerPort: 27015, protocol: "TCP" },
                    { containerPort: 27015, protocol: "UDP" },
                    { containerPort: 27020, protocol: "TCP" },
                    { containerPort: 27020, protocol: "UDP" },
                  ],
                  env: [
                    { name: "GAME_ID", value: "730" },
                    { name: "GAME_NAME", value: "counter-strike" },
                    { name: "GAME_PORT", value: "27015" },
                    {
                      name: "GAME_PARAMS",
                      value: `-dedicated -dev +map de_inferno -usercon  +rcon_password ${process.env.DEFAULT_RCON_PASSWORD}
                         +sv_password ${match.password} -authkey ${process.env.CS_AUTH_KEY} -maxplayers 13`,
                    },
                    { name: "USERNAME", value: process.env.CS_USERNAME },
                    { name: "PASSWRD", value: process.env.CS_PASSWORD },
                    { name: "UID", value: "1000" },
                    { name: "GID", value: "1000" },
                    { name: "SERVER_ID", value: serverId },
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

      const { tvPort, gamePort } = await this.getServerPorts();

      console.trace(`[${matchId}] create service for on demand server`);

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
              port: 27015,
              targetPort: 27015,
              nodePort: gamePort,
              name: "rcon",
              protocol: "TCP",
            },
            {
              port: 27015,
              targetPort: 27015,
              nodePort: gamePort,
              name: "game",
              protocol: "UDP",
            },
            {
              port: 27020,
              targetPort: 27020,
              nodePort: tvPort,
              name: "tv",
              protocol: "TCP",
            },
            {
              port: 27020,
              targetPort: 27020,
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
        insert_servers_one: [
          {
            object: {
              id: serverId,
              on_demand: true,
              port: gamePort,
              tv_port: tvPort,
              label: `${jobName}`,
              host: process.env.SERVER_DOMAIN,
              rcon_password: process.env.DEFAULT_RCON_PASSWORD,
            },
          },
          {
            id: true,
          },
        ],
      });

      await this.hasura.mutation({
        update_matches_by_pk: [
          {
            pk_columns: {
              id: matchId,
            },
            _set: {
              server_id: serverId,
            },
          },
          {
            id: true,
          },
        ],
      });

      return true;
    } catch (error) {
      await this.stopOnDemandServer(matchId);

      console.error(
        `[${matchId}] unable to create on demand server`,
        error?.response?.body?.message || error.response
      );

      await this.updateMatchStatus(matchId, e_match_status_enum.Scheduled);

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
          `job-name=${jobName}`
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
        console.warn("unable to connect to server:", error.message);
        return false;
      }

      return true;
    } catch (error) {
      console.warn(
        `unable to check server status`,
        error?.response?.body?.message || error
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
      }
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

  private async stopOnDemandServer(matchId: string) {
    const server = await this.getMatchServer(matchId);

    if (!server || !server.on_demand) {
      return;
    }

    console.info(`[${matchId}] stopping match server`);

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
        `job-name=${jobName}`
      );
      for (const pod of pods.items) {
        console.trace(`[${matchId}] remove pod`);
        await core.deleteNamespacedPod(pod.metadata!.name!, this.namespace);
      }

      console.trace(`[${matchId}] remove job`);
      await batch.deleteNamespacedJob(jobName, this.namespace);

      console.trace(`[${matchId}] remove service`);
      await core.deleteNamespacedService(jobName, this.namespace);

      await this.hasura.mutation({
        delete_servers_by_pk: [
          {
            id: server.id,
          },
          {
            id: true,
          },
        ],
      });
    } catch (error) {
      console.error(
        `[${matchId}] unable to stop on demand server`,
        error?.response?.body?.message || error
      );
    }
  }

  public async getAvailableMaps(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          map_pool: {
            maps: [
              {},
              {
                id: true,
                name: true,
              },
            ],
          },
          veto_picks: [
            {
              where: {
                _or: [
                  {
                    type: {
                      _eq: e_veto_pick_types_enum.Ban,
                    },
                  },
                  {
                    type: {
                      _eq: e_veto_pick_types_enum.Pick,
                    },
                  },
                ],
              },
            },
            {
              map_id: true,
            },
          ],
        },
      ],
    });

    if (!matches_by_pk?.map_pool) {
      throw Error("unable to find match maps");
    }

    return matches_by_pk.map_pool.maps.filter((map) => {
      return !matches_by_pk.veto_picks.find((veto) => {
        return veto.map_id === map.id;
      });
    });
  }

  private async command(matchId: string, command: Array<string> | string) {
    const server = await this.getMatchServer(matchId);
    if (!server) {
      console.warn(`[${matchId}] server was not assigned to this match`);
      return;
    }
    const rcon = await this.rcon.connect(server.id);

    return await rcon.send(
      Array.isArray(command) ? command.join(";") : command
    );
  }

  private async getServerPorts() {
    const { servers } = await this.hasura.query({
      servers: [
        {
          where: {
            on_demand: {
              _eq: true,
            },
            matches: {
              status: {
                _nin: [
                  e_match_status_enum.Scheduled,
                  e_match_status_enum.Canceled,
                  e_match_status_enum.Finished,
                ],
              },
            },
          },
        },
        {
          id: true,
          port: true,
          tv_port: true,
        },
      ],
    });

    const portsTaken = servers.flatMap((server) => {
      const ports = [server.port];

      if (server.tv_port) {
        ports.push(server.tv_port);
      }

      return ports;
    });

    const availablePorts = new Array(
      this.SERVER_PORT_END - this.SERVER_PORT_START + 1
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

    const availableIndicesAfterFirstSelection = this.getAvailablePortIndices(
      availablePorts
    );

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

  private getAvailablePortIndices(array) {
    return array.reduce((acc, isAvailable, index) => {
      if (isAvailable) {
        acc.push(index);
      }
      return acc;
    }, []);
  }

  public async isMatchOrganizer(matchId: string, user: User) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          id: true,
          status: true,
          organizer_steam_id: true,
        },
      ],
    });

    if (match?.organizer_steam_id?.toString() !== user.steam_id) {
      throw Error("Not Authorized");
    }
  }
}
