import { Injectable, Logger } from "@nestjs/common";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  V1Job,
  V1EnvVar,
  V1Service,
} from "@kubernetes/client-node";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../../hasura/hasura.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";
import { e_game_server_node_statuses_enum } from "../../../generated";
import { AppConfig } from "../../configs/types/AppConfig";

type StreamerMode = "live" | "create-clips";

const GAME_STREAMER_TITLE = "5Stack Game Streamer";

@Injectable()
export class GameStreamerService {
  private readonly namespace: string;
  private readonly gameServerConfig: GameServersConfig;
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.appConfig = this.config.get<AppConfig>("app");
    this.namespace = this.gameServerConfig.namespace;
  }

  public static GetLiveJobId(matchId: string) {
    return `gs-live-${matchId}`;
  }

  public static GetLiveServiceName(matchId: string) {
    return `gs-live-${matchId}`;
  }

  private getSpecServerUrl(matchId: string, action: string) {
    const svc = GameStreamerService.GetLiveServiceName(matchId);
    return `http://${svc}.${this.namespace}.svc.cluster.local:1350/spec/${action}`;
  }

  private async callSpec(
    matchId: string,
    action: "click" | "jump" | "player" | "slot" | "autodirector",
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    const url = this.getSpecServerUrl(matchId, action);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      const cause = (error as Error)?.cause as
        | { code?: string; message?: string }
        | undefined;
      const code = cause?.code ?? (error as { code?: string })?.code;
      const message = (error as Error)?.message ?? String(error);

      this.logger.error(
        `[${matchId}] spec ${action} transport error: code=${code ?? "<none>"} message=${message} url=${url}`,
      );

      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw new Error(
          `no live stream is running for this match (spec-server DNS not found)`,
        );
      }
      if (code === "ECONNREFUSED") {
        throw new Error(
          `streamer pod is up but spec-server is not listening yet — try again in a few seconds`,
        );
      }
      if (
        (error as Error)?.name === "TimeoutError" ||
        code === "UND_ERR_CONNECT_TIMEOUT"
      ) {
        throw new Error(
          `spec-server timed out — the streamer pod is unhealthy`,
        );
      }
      throw new Error(`spec-server ${action} unreachable: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(
        `[${matchId}] spec ${action} -> ${res.status}: ${text.slice(0, 500)}`,
      );
      throw new Error(
        `spec-server ${action} -> ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res.json().catch(() => ({ ok: true }));
  }

  public async specClick(matchId: string, button: "left" | "right") {
    return this.callSpec(matchId, "click", { button });
  }

  public async specJump(matchId: string) {
    return this.callSpec(matchId, "jump");
  }

  public async specPlayer(matchId: string, accountid: number) {
    return this.callSpec(matchId, "player", { accountid });
  }

  public async specSlot(matchId: string, slot: number) {
    return this.callSpec(matchId, "slot", { slot });
  }

  public async specAutodirector(matchId: string, enabled: boolean) {
    const result = await this.callSpec(matchId, "autodirector", { enabled });
    await this.hasura.mutation({
      update_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          // Generated Hasura types lag this migration until codegen runs.
          _set: { autodirector: enabled } as any,
        },
        affected_rows: true,
      },
    });
    return result;
  }

  public static GetClipsJobId(matchId: string) {
    return `gs-clips-${matchId}`;
  }

  public async startLive(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        region: true,
        password: true,
        server: {
          host: true,
          port: true,
          tv_port: true,
        },
      },
    });

    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }

    if (!match.server) {
      throw new Error("no server assigned for match");
    }

    const usePlaycast = await this.readUsePlaycast();

    const nodeId = await this.pickGpuNode(match.region);

    const connectEnv = await this.buildConnectEnv(
      matchId,
      match.server,
      match.password,
      usePlaycast,
    );

    const reporterEnv: V1EnvVar[] = [
      { name: "MATCH_PASSWORD", value: match.password },
    ];

    const jobName = GameStreamerService.GetLiveJobId(matchId);

    await this.deleteJob(jobName);

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(`[${matchId}] starting live stream on node ${nodeId}`);

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(jobName, matchId, "live", nodeId, [
        ...connectEnv,
        ...reporterEnv,
      ]),
    });

    await this.createLiveService(matchId);

    await this.registerStreamRow(matchId);
  }

  public async stopLive(matchId: string) {
    const jobName = GameStreamerService.GetLiveJobId(matchId);
    this.logger.log(`[${matchId}] stopping live stream`);

    let kubeError: unknown = null;
    try {
      await this.deleteJob(jobName);
    } catch (error) {
      kubeError = error;
      this.logger.error(
        `[${matchId}] deleteJob failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.deleteLiveService(matchId);
    } catch (error) {
      this.logger.error(
        `[${matchId}] deleteLiveService failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.unregisterStreamRow(matchId);
    } catch (error) {
      this.logger.error(
        `[${matchId}] unregisterStreamRow failed: ${(error as Error)?.message}`,
      );
      throw kubeError ?? error;
    }

    if (kubeError) {
      throw kubeError;
    }
  }

  public async createClips(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        region: true,
      },
    });

    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }

    const nodeId = await this.pickGpuNode(match.region);

    const jobName = GameStreamerService.GetClipsJobId(matchId);

    await this.deleteJob(jobName);

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(`[${matchId}] creating clips on node ${nodeId}`);

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(jobName, matchId, "create-clips", nodeId, []),
    });
  }

  private async readUsePlaycast(): Promise<boolean> {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: "use_playcast" },
        name: true,
        value: true,
      },
    });
    return settings_by_pk?.value === "true";
  }

  private async pickGpuNode(matchRegion: string | null): Promise<string> {
    const baseWhere = {
      status: {
        _eq: "Online" as e_game_server_node_statuses_enum,
      },
      enabled: { _eq: true },
      gpu: { _eq: true },
    };

    let { game_server_nodes: nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: matchRegion
            ? { ...baseWhere, region: { _eq: matchRegion } }
            : baseWhere,
        },
        id: true,
      },
    });

    if (nodes.length === 0 && matchRegion) {
      ({ game_server_nodes: nodes } = await this.hasura.query({
        game_server_nodes: {
          __args: { where: baseWhere },
          id: true,
        },
      }));
    }

    if (nodes.length === 0) {
      throw new Error("no GPU-capable game node available");
    }

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const jobs = await batch.listNamespacedJob({
      namespace: this.namespace,
      labelSelector: "app=game-streamer",
    });

    const usagePerNode = new Map<string, number>();
    for (const node of nodes) {
      usagePerNode.set(node.id, 0);
    }
    for (const job of jobs.items) {
      const pinnedNode =
        job.spec?.template?.spec?.affinity?.nodeAffinity
          ?.requiredDuringSchedulingIgnoredDuringExecution
          ?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values?.[0];
      if (pinnedNode && usagePerNode.has(pinnedNode)) {
        usagePerNode.set(pinnedNode, (usagePerNode.get(pinnedNode) ?? 0) + 1);
      }
    }

    let chosen = nodes[0].id;
    let chosenLoad = usagePerNode.get(chosen) ?? 0;
    for (const node of nodes) {
      const load = usagePerNode.get(node.id) ?? 0;
      if (load < chosenLoad) {
        chosen = node.id;
        chosenLoad = load;
      }
    }

    return chosen;
  }

  private async buildConnectEnv(
    matchId: string,
    server: {
      host: string;
      port: number;
      tv_port: number | null;
    },
    matchPassword: string,
    usePlaycast: boolean,
  ): Promise<V1EnvVar[]> {
    if (usePlaycast) {
      return [
        { name: "PLAYCAST_URL", value: `https://tv.5stack.gg/${matchId}` },
        { name: "PLAYCAST_PASSWORD", value: "" },
      ];
    }

    if (server.tv_port) {
      return [
        {
          name: "CONNECT_TV_ADDR",
          value: `${server.host}:${server.tv_port}`,
        },
        { name: "CONNECT_TV_PASSWORD", value: matchPassword },
      ];
    }

    return [
      { name: "CONNECT_ADDR", value: `${server.host}:${server.port}` },
      { name: "CONNECT_PASSWORD", value: `tv:user:${matchPassword}` },
    ];
  }

  private async createLiveService(matchId: string) {
    const serviceName = GameStreamerService.GetLiveServiceName(matchId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);

    await this.deleteLiveService(matchId);

    const body: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: serviceName,
        labels: {
          app: "game-streamer",
          role: "live",
          "match-id": matchId,
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: "game-streamer",
          role: "live",
          "match-id": matchId,
        },
        ports: [
          { name: "openhud", port: 1349, targetPort: "openhud" as any },
          { name: "spec", port: 1350, targetPort: "spec" as any },
        ],
      },
    };

    await core.createNamespacedService({
      namespace: this.namespace,
      body,
    });
  }

  private async deleteLiveService(matchId: string) {
    const serviceName = GameStreamerService.GetLiveServiceName(matchId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    try {
      await core.deleteNamespacedService({
        name: serviceName,
        namespace: this.namespace,
      });
    } catch (error) {
      if (error.code?.toString() !== "404") {
        throw error;
      }
    }
  }

  private async deleteJob(jobName: string) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    const batch = kc.makeApiClient(BatchV1Api);

    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });

    for (const pod of pods.items) {
      await core
        .deleteNamespacedPod({
          name: pod.metadata!.name!,
          namespace: this.namespace,
          gracePeriodSeconds: 0,
        })
        .catch((error) => {
          if (error.code?.toString() !== "404") {
            throw error;
          }
        });
    }

    await batch
      .deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        propagationPolicy: "Background",
        gracePeriodSeconds: 0,
      })
      .catch((error) => {
        if (error.code?.toString() !== "404") {
          throw error;
        }
      });

    // Avoid a create/delete race while Kubernetes releases the Job name.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await batch.readNamespacedJob({
          name: jobName,
          namespace: this.namespace,
        });
      } catch (error) {
        if (error.code?.toString() === "404") {
          return;
        }
        throw error;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private async registerStreamRow(matchId: string) {
    await this.unregisterStreamRow(matchId);
    await this.hasura.mutation({
      insert_match_streams_one: {
        __args: {
          object: {
            match_id: matchId,
            title: GAME_STREAMER_TITLE,
            link: `${this.appConfig.gameStreamHlsBase}/${matchId}/`,
            priority: 0,
            is_game_streamer: true,
            is_live: false,
            status: "launching_steam",
            last_status_at: "now()",
          },
        },
        id: true,
      },
    });
  }

  public async validateStatusOriginAuth(
    matchId: string,
    originAuth: unknown,
  ): Promise<boolean> {
    if (!originAuth || typeof originAuth !== "string") {
      return false;
    }
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) {
      return false;
    }
    const headerMatchId = originAuth.substring(0, colonIndex);
    const apiPassword = originAuth.substring(colonIndex + 1);

    if (!timingSafeStringEqual(headerMatchId, matchId)) {
      return false;
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        password: true,
      },
    });

    const matchPassword = match?.password ?? null;

    if (!matchPassword || typeof matchPassword !== "string") {
      return false;
    }

    return timingSafeStringEqual(matchPassword, apiPassword);
  }

  public async reportStatus(matchId: string, body: GameStreamerStatusDto) {
    const setClause = {
      status: body.status,
      stream_url: body.stream_url ?? null,
      error_message: body.error ?? null,
      last_status_at: "now()",
      is_live: body.status === "live",
    };

    const result = await this.hasura.mutation({
      update_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          _set: setClause,
        },
        affected_rows: true,
      },
    });

    const updated = result.update_match_streams.affected_rows;
    this.logger.log(
      `[${matchId}] reportStatus status=${body.status} updated=${updated}`,
    );

    if (updated === 0) {
      this.logger.log(
        `[${matchId}] no existing row — falling back to delete + insert`,
      );
      await this.hasura.mutation({
        delete_match_streams: {
          __args: {
            where: {
              match_id: { _eq: matchId },
              is_game_streamer: { _eq: true },
            },
          },
          affected_rows: true,
        },
        insert_match_streams_one: {
          __args: {
            object: {
              match_id: matchId,
              title: GAME_STREAMER_TITLE,
              link: `${this.appConfig.gameStreamHlsBase}/${matchId}/`,
              priority: 0,
              is_game_streamer: true,
              ...setClause,
            },
          },
          id: true,
        },
      });
      this.logger.log(`[${matchId}] inserted new match_streams row`);
    }

    if (body.status === "live") {
      this.logger.log(`[${matchId}] "${GAME_STREAMER_TITLE}" → live`);
    } else if (body.status === "errored") {
      this.logger.warn(
        `[${matchId}] streamer errored: ${body.error ?? "<no message>"}`,
      );
    }
  }

  private async unregisterStreamRow(matchId: string) {
    await this.hasura.mutation({
      delete_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
        },
        affected_rows: true,
      },
    });
  }

  private buildJobSpec(
    jobName: string,
    matchId: string,
    mode: StreamerMode,
    nodeId: string,
    extraEnv: V1EnvVar[],
  ): V1Job {
    const containerName = mode === "create-clips" ? "clips" : "live";

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        labels: {
          app: "game-streamer",
          role: mode,
          "match-id": matchId,
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 60 * 60 * 24,
        template: {
          metadata: {
            labels: {
              app: "game-streamer",
              role: mode,
              "match-id": matchId,
            },
          },
          spec: {
            restartPolicy: "Never",
            runtimeClassName: "nvidia",
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: "kubernetes.io/hostname",
                          operator: "In",
                          values: [nodeId],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            initContainers: [
              {
                name: "prep-cache",
                image: "busybox:1.36",
                command: [
                  "sh",
                  "-c",
                  "mkdir -p /mnt/game-streamer/steam /mnt/game-streamer/steamapps /mnt/game-streamer/demos /mnt/game-streamer/clips",
                ],
                volumeMounts: [
                  { name: "cache", mountPath: "/mnt/game-streamer" },
                ],
              },
            ],
            containers: [
              {
                name: containerName,
                image: "ghcr.io/5stackgg/game-streamer:latest",
                // Mutable tag; force each pod start to resolve the latest digest.
                imagePullPolicy: "Always",
                securityContext: { privileged: true },
                args: [mode === "live" ? "live" : "create-clips"],
                ports:
                  mode === "live"
                    ? [
                        { name: "openhud", containerPort: 1349 },
                        { name: "spec", containerPort: 1350 },
                      ]
                    : undefined,
                env: [
                  { name: "MATCH_ID", value: matchId },
                  { name: "DISPLAY_SIZEW", value: "1920" },
                  { name: "DISPLAY_SIZEH", value: "1080" },
                  { name: "OPENHUD_AUTO_OVERLAY", value: "1" },
                  ...extraEnv,
                ],
                envFrom: [{ secretRef: { name: "steam-secrets" } }],
                resources: {
                  limits: {
                    memory: "16Gi",
                    cpu: "8",
                    "nvidia.com/gpu": "1",
                  },
                  requests: {
                    memory: "2Gi",
                    cpu: "1",
                    "nvidia.com/gpu": "1",
                  },
                },
                volumeMounts: [
                  { name: "dshm", mountPath: "/dev/shm" },
                  // Keep Steam on one mount; a second subPath mount caused EXDEV.
                  { name: "cache", mountPath: "/mnt/game-streamer" },
                ],
              },
            ],
            volumes: [
              {
                name: "dshm",
                emptyDir: { medium: "Memory", sizeLimit: "2Gi" },
              },
              {
                name: "cache",
                hostPath: {
                  path: "/opt/5stack/game-streamer",
                  type: "DirectoryOrCreate",
                },
              },
            ],
          },
        },
      },
    };
  }
}
