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
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";
import { e_game_server_node_statuses_enum } from "../../../generated";

type StreamerMode = "live" | "create-clips";

// Public HLS viewer base. Surfaced to the frontend via the match_streams
// row's `link`. Defaults match the dev cluster; production should set
// GAME_STREAM_HLS_BASE on the api deployment.
const GAME_STREAM_HLS_BASE =
  process.env.GAME_STREAM_HLS_BASE ?? "https://hls.5stack.gg";

const GAME_STREAMER_TITLE = "5Stack Game Streamer";

@Injectable()
export class GameStreamerService {
  private readonly namespace: string;
  private readonly gameServerConfig: GameServersConfig;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.namespace = this.gameServerConfig.namespace;
  }

  public static GetLiveJobId(matchId: string) {
    return `gs-live-${matchId}`;
  }

  // Stable in-cluster DNS name for the live pod's HTTP endpoints
  // (openhud admin UI on :1349, spec-server on :1350). Same name as
  // the Job so it's easy to map by eye. Other services in the cluster
  // (api, web) reach the pod via:
  //   http://gs-live-<matchId>.<namespace>.svc.cluster.local:1349
  //   http://gs-live-<matchId>.<namespace>.svc.cluster.local:1350
  public static GetLiveServiceName(matchId: string) {
    return `gs-live-${matchId}`;
  }

  // Build the spec-server URL for a given match's pod. Used by
  // startLive's caller (matches.controller spec* actions) to forward
  // operator commands from the web UI into the streamer pod.
  private getSpecServerUrl(matchId: string, action: string) {
    const svc = GameStreamerService.GetLiveServiceName(matchId);
    return `http://${svc}.${this.namespace}.svc.cluster.local:1350/spec/${action}`;
  }

  // Thin proxy to the per-match spec-server. Caller is responsible
  // for auth (isRoleAbove streamer); we just forward + parse JSON.
  // 5s timeout — spec-server is fast (single xdotool roundtrip), so
  // anything slower means the pod is unhealthy and we should surface
  // the failure rather than block the operator's UI.
  //
  // Errors are caught and rethrown with a human-friendly message so
  // operators see "no live stream is running for this match" instead of
  // a raw `fetch failed` / `getaddrinfo ENOTFOUND`. The classification
  // logic differentiates the most common cases — pod missing (DNS
  // doesn't resolve), pod unreachable (TCP refused), and timeout — so
  // the surfaced message matches reality.
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
    // Persist the operator's choice so it survives page reloads,
    // caster handoffs, and streamer pod restarts. Hasura subscriptions
    // on match_streams pick up the change automatically; the toggle
    // re-renders for any other caster watching the same match.
    await this.hasura.mutation({
      update_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          // Cast: the `autodirector` column is added by migration
          // 1777400000000_add_autodirector_to_match_streams. Generated
          // Hasura types lag the migration until the next codegen run.
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

    // Threaded into the pod so its status-reporter daemon can POST back
    // to /game-streamer/:matchId/status with x-origin-auth: <id>:<password>.
    // The API URL is hard-coded inside the streamer image (in-cluster
    // Service name); only the per-match password needs to be injected.
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

    // Service fronting the pod's openhud + spec-server endpoints,
    // selecting on the same labels we put on the Job's pod template.
    // Created BEFORE the pod is ready — kube-proxy will start
    // routing as soon as the pod's readiness probes pass (we have
    // none defined, so as soon as the container is running).
    await this.createLiveService(matchId);

    // Insert the row immediately so the web UI flips the "Start Live
    // Stream" button to a "booting" state without having to wait for
    // the pod to come up and post its first status. `reportStatus`
    // upserts on top of this row, and is the fallback path that
    // recreates the row if this insert fails (DB hiccup) or a stale
    // row from a prior run is in the way.
    await this.registerStreamRow(matchId);
  }

  public async stopLive(matchId: string) {
    const jobName = GameStreamerService.GetLiveJobId(matchId);
    this.logger.log(`[${matchId}] stopping live stream`);

    // Always tear down the Job, the per-match Service, AND the
    // match_streams row, even if any individual step errors. A user
    // clicking "stop" expects the UI to reflect that — a stranded
    // row, dangling Service, or zombie pod each breaks the UX in
    // different ways.
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
      // Don't override an earlier kubeError — the job tear-down is
      // the more important signal to the operator. Just log.
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
      // Re-throw the original kube error if we had one; otherwise this one.
      throw kubeError ?? error;
    }

    if (kubeError) {
      // Row is gone but the job wasn't — surface so the operator knows.
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

  // Reads the global use_playcast setting that game-streamer's connect mode
  // depends on. Mirrors how matches.controller.ts populates match.options.
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

  // Selects a GPU-capable game-server-node to pin the streamer Job to.
  // Prefers the match region; counts active streamer Jobs per node and picks
  // the least-loaded so multi-node clusters round-robin under load.
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

    // Fallback: any region with a GPU node.
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

  // Create the per-match Service that fronts the live pod's HTTP
  // endpoints (openhud :1349 + spec-server :1350). Idempotent: if a
  // Service with this name already exists (back-to-back start/stop),
  // delete it first so the selector + ports are guaranteed fresh.
  // ClusterIP only — these ports are for in-cluster api/web callers,
  // not the public internet (the K8s Ingress can expose specific
  // routes to the public web app if needed).
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
        // Selector matches buildJobSpec()'s pod template labels —
        // app=game-streamer + role=live + match-id=<id> uniquely
        // picks this match's pod, even if another match's pod is
        // running on the same node.
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

    // Wait until the Job name is fully released; otherwise an immediate
    // createNamespacedJob with the same name races against delete propagation
    // and gets HTTP 409 AlreadyExists.
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

  // INSERT the row in the booting state so the UI can pick it up
  // immediately. Idempotent: drops any prior row for this match first
  // so a stale row from a previous start doesn't duplicate.
  private async registerStreamRow(matchId: string) {
    await this.unregisterStreamRow(matchId);
    await this.hasura.mutation({
      insert_match_streams_one: {
        __args: {
          object: {
            match_id: matchId,
            title: GAME_STREAMER_TITLE,
            link: `${GAME_STREAM_HLS_BASE}/${matchId}/`,
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

  // Apply a status update from the streamer pod. Latest-wins: the pod's
  // reporter daemon retries with the latest desired state until a 200,
  // so each call from there is the current truth. is_live mirrors
  // status === "live" so the existing frontend subscription column
  // keeps working unchanged.
  //
  // Upsert semantics: the streamer is the source of truth for whether
  // a row should exist. If the update touches no rows we delete any
  // stale is_game_streamer row for this match and insert a fresh one.
  // That covers (a) first status POST after a clean startLive, (b) a
  // DB failure during startLive that left the row missing, and (c) a
  // pod that survived a stopLive long enough to keep posting.
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
              link: `${GAME_STREAM_HLS_BASE}/${matchId}/`,
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
                // We push to the mutable :latest tag, so each pod
                // start has to re-resolve the digest. IfNotPresent
                // would keep running the node-cached old image
                // indefinitely, even after a fresh push.
                imagePullPolicy: "Always",
                securityContext: { privileged: true },
                // The image's ENTRYPOINT is `game-streamer.sh`. Pass the
                // subcommand explicitly so the pod actually runs the
                // flow on container start instead of printing help.
                args: [mode === "live" ? "live" : "create-clips"],
                // Container-side declarations for the HTTP endpoints
                // the per-match Service routes to. Only meaningful for
                // the live mode — clips renders don't expose either.
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
                  // Single cache mount. Steam state lives at
                  // /mnt/game-streamer/steam (a real subdir of this
                  // mount); setup-steam symlinks /root/.local/share/Steam
                  // to it so everything Steam writes is on ONE filesystem.
                  // A second bind mount on /root/.local/share/Steam
                  // (subPath: steam) caused EXDEV during Steam
                  // self-update — rename(2) across the two mount entries
                  // failed even though they pointed at the same data.
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
