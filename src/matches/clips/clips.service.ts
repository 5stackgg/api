import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { e_player_roles_enum } from "generated/schema";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { DemoMetadataService } from "../../demos/demo-metadata.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";

// String literal to avoid a load-time cycle with the worker.
const BATCH_HIGHLIGHTS_JOB_NAME = "BatchHighlightsRenderJob";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { ClipSpec } from "./types/ClipSpec";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";

const STATUS_HISTORY_CAP = 50;

const IN_FLIGHT_STATUSES = ["queued", "rendering", "uploading"] as const;

@Injectable()
export class ClipsService {
  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly s3: S3Service,
    private readonly gameStreamer: GameStreamerService,
    private readonly demoMetadata: DemoMetadataService,
    @InjectQueue(MatchQueues.ClipRenderBatch)
    private readonly batchQueue: Queue,
  ) {}

  private async resolveSteamPersonas(
    steamIds: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (steamIds.length === 0) return out;
    const apiKey = this.config.get<string>("steam.steamApiKey");
    if (!apiKey) {
      this.logger.warn(
        "[auto-clips] STEAM_WEB_API_KEY not set — cannot resolve persona names from Steam",
      );
      return out;
    }
    for (let i = 0; i < steamIds.length; i += 100) {
      const batch = steamIds.slice(i, i + 100).join(",");
      try {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${batch}`;
        const response = await fetch(url);
        if (!response.ok) {
          this.logger.warn(
            `[auto-clips] Steam GetPlayerSummaries returned ${response.status} — skipping persona resolve`,
          );
          continue;
        }
        const json = (await response.json()) as {
          response?: {
            players?: Array<{ steamid?: string; personaname?: string }>;
          };
        };
        for (const p of json.response?.players ?? []) {
          if (p?.steamid && p?.personaname) {
            out.set(String(p.steamid), String(p.personaname));
          }
        }
      } catch (error) {
        this.logger.warn(
          `[auto-clips] Steam persona resolve failed: ${(error as Error)?.message}`,
        );
      }
    }
    return out;
  }

  public static GetClipS3Key(userSteamId: string, jobId: string) {
    return `clips/${userSteamId}/${jobId}.mp4`;
  }
  public static GetClipThumbnailS3Key(userSteamId: string, jobId: string) {
    return `clips/${userSteamId}/${jobId}.jpg`;
  }

  public async createClipRender(
    userSteamId: string,
    spec: ClipSpec,
  ): Promise<{ jobId: string }> {
    this.validateSpec(spec);

    const session = await this.findActiveDemoSession(
      userSteamId,
      spec.match_map_id,
    );
    if (!session) {
      throw new Error(
        "open the demo (click 'Watch demo') before creating a clip — the render runs in the same pod that's playing it back",
      );
    }

    const inflight = await this.findInFlightForUser(userSteamId);
    if (inflight) {
      throw new Error(
        "you already have a clip render in progress — wait for it to finish or cancel it",
      );
    }

    const sessionToken = randomBytes(24).toString("hex");

    const { insert_clip_render_jobs_one } = await this.hasura.mutation({
      insert_clip_render_jobs_one: {
        __args: {
          object: {
            user_steam_id: userSteamId,
            match_map_id: spec.match_map_id,
            session_token: sessionToken,
            k8s_job_name: session.k8s_job_name,
            spec,
            status: "queued",
            status_history: [
              { status: "queued", at: new Date().toISOString() },
            ],
          },
        },
        id: true,
      },
    });
    const jobId = insert_clip_render_jobs_one?.id;
    if (!jobId) {
      throw new Error("failed to insert clip_render_jobs row");
    }

    const dims = spec.output.resolution === "720p" ? "1280x720" : "1920x1080";
    const renderSpeed = this.resolveRenderSpeed();
    const totalTicks = spec.segments.reduce(
      (acc, s) => acc + (s.end_tick - s.start_tick),
      0,
    );

    this.logger.log(
      `[clip ${jobId}] dispatching to pod=${session.id} ` +
        `speed=${renderSpeed}x ` +
        `segments=${spec.segments.length} total_ticks=${totalTicks} ` +
        `output=${dims}@${spec.output.fps}fps ` +
        `dest=${spec.destination}`,
    );

    try {
      await this.gameStreamer.dispatchClipRenderToPod(session.id, {
        job_id: jobId,
        token: sessionToken,
        api_base: this.resolveInClusterApiBase(),
        segments: spec.segments.map((s) => ({
          start_tick: s.start_tick,
          end_tick: s.end_tick,
          pov_steam_id: s.pov_steam_id,
        })),
        output_dims: dims,
        output_fps: spec.output.fps,
        render_speed: renderSpeed,
      });
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] dispatch to pod failed: ${(error as Error)?.message}`,
      );
      await this.hasura.mutation({
        update_clip_render_jobs_by_pk: {
          __args: {
            pk_columns: { id: jobId },
            _set: {
              status: "error",
              error_message: `dispatch failed: ${(error as Error)?.message}`,
              last_status_at: "now()",
            },
          },
          id: true,
        },
      });
      throw error;
    }

    return { jobId };
  }

  // Order matters: flip rows to cancelled first (pod's
  // inline-clip-render.sh skips on `cancelled`), drop the BullMQ
  // job so the watcher won't redispatch, then kill the pod.
  public async cancelClipRenderBatch(matchMapId: string): Promise<number> {
    const { update_clip_render_jobs } = await this.hasura.mutation({
      update_clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: ["queued", "rendering", "uploading"] },
          },
          _set: {
            status: "cancelled",
            error_message: "cancelled by operator (batch)",
            last_status_at: "now()",
          },
        },
        affected_rows: true,
      },
    });
    const cancelled = (update_clip_render_jobs?.affected_rows as number) ?? 0;

    try {
      const job = await this.batchQueue.getJob(matchMapId);
      if (job) {
        await job.remove();
      }
    } catch (error) {
      this.logger.warn(
        `[cancel-batch ${matchMapId}] BullMQ remove failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.gameStreamer.killBatchHighlightsPod(matchMapId);
    } catch (error) {
      this.logger.warn(
        `[cancel-batch ${matchMapId}] pod kill failed: ${(error as Error)?.message}`,
      );
    }

    this.logger.log(
      `[cancel-batch ${matchMapId}] cancelled ${cancelled} row(s) and torn down pod`,
    );
    return cancelled;
  }

  public async cancelClipRender(userSteamId: string, jobId: string) {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        status: true,
      },
    });
    if (!row) {
      throw new Error(`clip render ${jobId} not found`);
    }
    if (String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only cancel your own clip renders");
    }
    if (
      row.status === "done" ||
      row.status === "error" ||
      row.status === "cancelled"
    ) {
      return;
    }

    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: {
            status: "cancelled",
            error_message: "cancelled by user",
            last_status_at: "now()",
          },
        },
        id: true,
      },
    });
  }

  private resolveInClusterApiBase(): string {
    return process.env.API_INTERNAL_BASE ?? "http://api:5585";
  }

  private resolveRenderSpeed(): number {
    const raw = process.env.CLIP_RENDER_SPEED;
    if (!raw) return 1;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    if (parsed > 4) {
      this.logger.warn(
        `[clips] CLIP_RENDER_SPEED='${raw}' clamped to 4 (anything higher destabilises cs2)`,
      );
      return 4;
    }
    return parsed;
  }

  private async findActiveDemoSession(
    userSteamId: string,
    matchMapId: string,
  ): Promise<{ id: string; k8s_job_name: string } | null> {
    const { match_demo_sessions } = await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: {
            watcher_steam_id: { _eq: userSteamId },
            match_map_id: { _eq: matchMapId },
          },
          limit: 1,
        },
        id: true,
        k8s_job_name: true,
        status: true,
      },
    });
    const row = match_demo_sessions?.[0];
    if (!row) return null;
    if (row.status !== "playing") return null;
    return { id: row.id, k8s_job_name: row.k8s_job_name };
  }

  public async updateClip(
    userSteamId: string,
    clipId: string,
    patch: {
      title?: string | null;
      visibility?: "private" | "unlisted" | "match" | "public";
      target_steam_id?: string | null;
    },
  ): Promise<void> {
    const { match_clips_by_pk: row } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
        user_steam_id: true,
      },
    });
    if (!row) {
      throw new Error(`clip ${clipId} not found`);
    }
    if (String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only edit your own clips");
    }

    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const trimmed = patch.title?.trim() ?? null;
      set.title = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (patch.visibility !== undefined) {
      const allowed = ["private", "unlisted", "match", "public"];
      if (!allowed.includes(patch.visibility)) {
        throw new Error(
          `invalid visibility "${patch.visibility}" — must be one of ${allowed.join(", ")}`,
        );
      }
      set.visibility = patch.visibility;
    }
    if (patch.target_steam_id !== undefined) {
      // FK requires a players row; fall back to null silently if missing.
      if (patch.target_steam_id === null) {
        set.target_steam_id = null;
      } else {
        const { players } = await this.hasura.query({
          players: {
            __args: {
              where: { steam_id: { _eq: patch.target_steam_id } },
              limit: 1,
            },
            steam_id: true,
          },
        });
        set.target_steam_id = players?.[0]?.steam_id ?? null;
      }
    }
    if (Object.keys(set).length === 0) return;

    await this.hasura.mutation({
      update_match_clips_by_pk: {
        __args: { pk_columns: { id: clipId }, _set: set },
        id: true,
      },
    });
  }

  public async deleteClip(
    userSteamId: string,
    clipId: string,
    actorIsOperator = false,
  ) {
    const { match_clips_by_pk: row } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
        user_steam_id: true,
        file: true,
      },
    });
    if (!row) {
      throw new Error(`clip ${clipId} not found`);
    }
    if (!actorIsOperator && String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only delete your own clips");
    }

    const fileKey = row.file ?? ClipsService.GetClipS3Key(userSteamId, clipId);
    try {
      await this.s3.remove(fileKey);
      await this.s3.remove(
        ClipsService.GetClipThumbnailS3Key(userSteamId, clipId),
      );
    } catch (error) {
      this.logger.warn(
        `[clip ${clipId}] s3 remove failed: ${(error as Error)?.message}`,
      );
    }

    await this.hasura.mutation({
      delete_match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
      },
    });
  }

  public async validateClipRenderAuth(
    jobId: string,
    originAuth: unknown,
  ): Promise<{
    id: string;
    user_steam_id: string;
    match_map_id: string;
  } | null> {
    if (!originAuth || typeof originAuth !== "string") return null;
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) return null;
    const headerJobId = originAuth.substring(0, colonIndex);
    const presentedToken = originAuth.substring(colonIndex + 1);
    if (!timingSafeStringEqual(headerJobId, jobId)) return null;

    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: { id: { _eq: jobId } },
          limit: 1,
        },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        session_token: true,
      },
    });
    const row = clip_render_jobs?.[0];
    if (!row?.session_token) return null;
    if (!timingSafeStringEqual(row.session_token, presentedToken)) return null;

    return {
      id: row.id,
      user_steam_id: String(row.user_steam_id),
      match_map_id: row.match_map_id,
    };
  }

  public async patchClipRenderTitle(jobId: string, title: string) {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        spec: true,
      },
    });
    if (!row) return;
    const nextSpec = { ...(row.spec as any), title };
    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: { spec: nextSpec },
        },
        id: true,
      },
    });
  }

  public async getClipRenderStatus(
    jobId: string,
  ): Promise<{ status: string } | null> {
    const { clip_render_jobs_by_pk } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        status: true,
      },
    });
    if (!clip_render_jobs_by_pk) return null;
    return { status: String(clip_render_jobs_by_pk.status) };
  }

  public async reportClipRenderStatus(
    jobId: string,
    body: ClipRenderStatusDto,
  ) {
    const { clip_render_jobs_by_pk: current } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        status_history: true,
      },
    });
    if (!current) {
      this.logger.warn(
        `[clip ${jobId}] reportStatus: row missing — was the job cancelled?`,
      );
      return;
    }

    const prevHistory = current.status_history as
      | Array<{ status: string; at: string }>
      | null
      | undefined;
    const nextHistory = Array.isArray(prevHistory) ? [...prevHistory] : [];
    nextHistory.push({ status: body.status, at: new Date().toISOString() });
    while (nextHistory.length > STATUS_HISTORY_CAP) nextHistory.shift();

    const set: Record<string, unknown> = {
      status: body.status,
      status_history: nextHistory,
      last_status_at: "now()",
    };
    if (
      typeof body.progress === "number" &&
      body.progress >= 0 &&
      body.progress <= 1
    ) {
      set.progress = body.progress;
    }
    if (body.error) {
      set.error_message = body.error;
    }
    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: { pk_columns: { id: jobId }, _set: set },
        id: true,
      },
    });
  }

  public async finalizeClipUpload(
    jobId: string,
    fileStream: Readable,
    durationMs: number | null,
  ): Promise<{ clipId: string; file: string }> {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        spec: true,
        status: true,
      },
    });
    if (!row) throw new Error(`clip render ${jobId} not found`);
    if (row.status === "cancelled") {
      throw new Error("render was cancelled");
    }

    const userSteamId = String(row.user_steam_id);
    const key = ClipsService.GetClipS3Key(userSteamId, jobId);

    await this.s3.put(key, fileStream);

    const spec = row.spec as unknown as ClipSpec;
    const title = spec?.title ?? null;
    const rawTarget = spec?.segments?.[0]?.pov_steam_id ?? null;
    let targetSteamId: string | null = null;
    if (rawTarget) {
      const { players } = await this.hasura.query({
        players: {
          __args: {
            where: { steam_id: { _eq: rawTarget } },
            limit: 1,
          },
          steam_id: true,
        },
      });
      if (players?.[0]?.steam_id) {
        targetSteamId = String(players[0].steam_id);
      } else if (spec?.target_name) {
        try {
          await this.hasura.mutation({
            insert_players: {
              __args: {
                objects: [
                  {
                    steam_id: rawTarget,
                    name: spec.target_name,
                    role: "user" as e_player_roles_enum,
                  },
                ],
                on_conflict: {
                  constraint: "players_pkey",
                  update_columns: [],
                },
              },
              affected_rows: true,
            },
          });
          targetSteamId = String(rawTarget);
        } catch (error) {
          this.logger.warn(
            `[clip ${jobId}] target steam_id ${rawTarget} upsert failed (${(error as Error)?.message}) — leaving target_steam_id null`,
          );
        }
      } else {
        this.logger.log(
          `[clip ${jobId}] target steam_id ${rawTarget} not in players table and spec has no target_name — leaving target_steam_id null`,
        );
      }
    }

    const visibility =
      (spec?.visibility as
        | "private"
        | "unlisted"
        | "public"
        | "match"
        | undefined) ?? "private";

    const { insert_match_clips_one } = await this.hasura.mutation({
      insert_match_clips_one: {
        __args: {
          object: {
            user_steam_id: userSteamId,
            target_steam_id: targetSteamId,
            match_map_id: row.match_map_id,
            title,
            duration_ms: durationMs,
            file: key,
            visibility,
          },
        },
        id: true,
      },
    });
    const clipId = insert_match_clips_one?.id;
    if (!clipId) throw new Error("failed to insert match_clips row");

    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: {
            status: "done",
            progress: 1,
            clip_id: clipId,
            last_status_at: "now()",
          },
        },
        id: true,
      },
    });

    return { clipId, file: key };
  }

  private async findInFlightForUser(userSteamId: string) {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            user_steam_id: { _eq: userSteamId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
          },
          limit: 1,
        },
        id: true,
        status: true,
      },
    });
    return clip_render_jobs?.[0] ?? null;
  }

  // One clip_render_jobs row per (match_map, killer). Returns the
  // number of jobs queued. force=true bypasses the setting toggle.
  public async autoGenerateForMatch(
    matchId: string,
    options: { force?: boolean } = {},
  ): Promise<number> {
    if (!options.force) {
      const enabled = await this.readBoolSetting(
        "auto_generate_match_clips",
        false,
      );
      if (!enabled) return 0;
    }

    const defaultVisibility = await this.readSetting(
      "auto_clip_default_visibility",
      "public",
    );

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        organizer_steam_id: true,
        match_maps: {
          id: true,
          demos: {
            id: true,
            kills: true,
            players: true,
            tick_rate: true,
            total_ticks: true,
            round_ticks: true,
          },
        },
      },
    });
    if (!match) {
      this.logger.warn(`[auto-clips] match ${matchId} not found`);
      return 0;
    }
    if (!match.organizer_steam_id) {
      this.logger.warn(
        `[auto-clips] match ${matchId} has no organizer_steam_id — skipping (need a clip owner)`,
      );
      return 0;
    }

    // Re-runs replace prior render bookkeeping; rendered match_clips stay.
    const matchMapIds = (match.match_maps ?? []).map((m: any) => String(m.id));
    if (matchMapIds.length > 0) {
      const { delete_clip_render_jobs } = await this.hasura.mutation({
        delete_clip_render_jobs: {
          __args: { where: { match_map_id: { _in: matchMapIds } } },
          affected_rows: true,
        },
      });
      const removed =
        (delete_clip_render_jobs?.affected_rows as number | undefined) ?? 0;
      if (removed > 0) {
        this.logger.log(
          `[auto-clips] match ${matchId} cleared ${removed} prior clip_render_jobs row(s) before re-queue`,
        );
      }
    }

    let queued = 0;
    // One batch pod per match_map (per .dem file).
    const perMap = new Map<
      string,
      Array<{ job_id: string; session_token: string; spec: any }>
    >();

    const allKillers = new Set<string>();
    for (const mapRow of match.match_maps ?? []) {
      const demo = mapRow.demos?.[0];
      const kills =
        (demo?.kills as Array<{ killer?: string }> | undefined) ?? [];
      for (const k of kills) if (k.killer) allKillers.add(k.killer);
    }

    const buildNameMapFromMatch = (m: any) => {
      const out = new Map<string, string>();
      for (const mapRow of m.match_maps ?? []) {
        const demo = mapRow.demos?.[0];
        const demoPlayers =
          (demo?.players as
            | Array<{ steam_id?: string; name?: string }>
            | undefined) ?? [];
        for (const p of demoPlayers) {
          if (p?.steam_id && p?.name) {
            out.set(String(p.steam_id), String(p.name));
          }
        }
      }
      return out;
    };

    let nameByStId = buildNameMapFromMatch(match);
    let unresolved = Array.from(allKillers).filter(
      (sid) => !nameByStId.has(sid),
    );

    if (unresolved.length > 0) {
      const mapsNeedingReparse = (match.match_maps ?? []).filter((m: any) => {
        const demo = m.demos?.[0];
        if (!demo?.id) return false;
        const kills =
          (demo.kills as Array<{ killer?: string }> | undefined) ?? [];
        const killersHere = new Set<string>();
        for (const k of kills) if (k.killer) killersHere.add(k.killer);
        for (const sid of unresolved) {
          if (killersHere.has(sid)) return true;
        }
        return false;
      });
      this.logger.warn(
        `[auto-clips] match ${matchId} has ${unresolved.length} killer steam_id(s) missing from demo.players (${unresolved.join(", ")}) — re-parsing ${mapsNeedingReparse.length} map_demo(s)`,
      );
      for (const m of mapsNeedingReparse) {
        const demoId = String(m.demos?.[0]?.id ?? "");
        if (!demoId) continue;
        try {
          await this.demoMetadata.reparseById(demoId);
        } catch (error) {
          this.logger.warn(
            `[auto-clips] match ${matchId} reparse failed for demo ${demoId}: ${(error as Error)?.message}`,
          );
        }
      }
      const { matches_by_pk: refreshed } = await this.hasura.query({
        matches_by_pk: {
          __args: { id: matchId },
          id: true,
          match_maps: {
            id: true,
            demos: {
              id: true,
              kills: true,
              players: true,
              tick_rate: true,
              total_ticks: true,
              round_ticks: true,
            },
          },
        },
      });
      if (refreshed) {
        nameByStId = buildNameMapFromMatch(refreshed);
        match.match_maps = refreshed.match_maps;
      }
      unresolved = Array.from(allKillers).filter((sid) => !nameByStId.has(sid));
      if (unresolved.length > 0) {
        this.logger.warn(
          `[auto-clips] match ${matchId} demo missing ${unresolved.length} killer name(s) after re-parse — falling back to Steam personas: ${unresolved.join(", ")}`,
        );
        const personas = await this.resolveSteamPersonas(unresolved);
        for (const [sid, name] of personas) {
          nameByStId.set(sid, name);
        }
        unresolved = Array.from(allKillers).filter(
          (sid) => !nameByStId.has(sid),
        );
        if (unresolved.length > 0) {
          this.logger.warn(
            `[auto-clips] match ${matchId} STILL missing ${unresolved.length} killer name(s) after Steam lookup: ${unresolved.join(", ")} — clips for these will queue as "Player NNNN" until the streamer pod's GSI patch fires`,
          );
        } else {
          this.logger.log(
            `[auto-clips] match ${matchId} resolved all missing killer names via Steam personas`,
          );
        }
      } else {
        this.logger.log(
          `[auto-clips] match ${matchId} re-parse resolved all missing killer names`,
        );
      }
    }

    // Upsert players rows so match_clips.target_steam_id FK lands.
    // update_columns:[] preserves existing players' profile data.
    const upsertObjects: Array<{
      steam_id: string;
      name: string;
      role: e_player_roles_enum;
    }> = [];
    for (const sid of allKillers) {
      const name = nameByStId.get(sid);
      if (!name) continue;
      upsertObjects.push({
        steam_id: sid,
        name,
        role: "user" as e_player_roles_enum,
      });
    }
    if (upsertObjects.length > 0) {
      try {
        await this.hasura.mutation({
          insert_players: {
            __args: {
              objects: upsertObjects,
              on_conflict: {
                constraint: "players_pkey",
                update_columns: [],
              },
            },
            affected_rows: true,
          },
        });
      } catch (error) {
        this.logger.warn(
          `[auto-clips] match ${matchId} player upsert failed: ${(error as Error)?.message}`,
        );
      }
    }

    for (const mapRow of match.match_maps ?? []) {
      const demo = mapRow.demos?.[0];
      const kills =
        (demo?.kills as Array<{ killer?: string }> | undefined) ?? [];
      if (!demo || kills.length === 0) continue;

      const killers = new Set<string>();
      for (const k of kills) if (k.killer) killers.add(k.killer);

      for (const targetSteamId of killers) {
        try {
          const spec = await this.buildPresetSpec(
            mapRow.id,
            targetSteamId,
            "best_round",
            { resolution: "1080p", fps: 60 },
            undefined,
            nameByStId.get(targetSteamId),
          );
          (spec as any).destination = "library";
          (spec as any).visibility = defaultVisibility;
          const sessionToken = randomBytes(24).toString("hex");
          const jobName = GameStreamerService.GetBatchHighlightsJobName(
            mapRow.id,
          );
          const { insert_clip_render_jobs_one } = await this.hasura.mutation({
            insert_clip_render_jobs_one: {
              __args: {
                object: {
                  user_steam_id: String(match.organizer_steam_id),
                  match_map_id: mapRow.id,
                  session_token: sessionToken,
                  k8s_job_name: jobName,
                  spec,
                  status: "queued",
                  status_history: [
                    {
                      status: "queued",
                      at: new Date().toISOString(),
                      source: "auto_generate_match_clips",
                      target_steam_id: targetSteamId,
                      default_visibility: defaultVisibility,
                    },
                  ],
                },
              },
              id: true,
            },
          });
          const insertedId = insert_clip_render_jobs_one?.id as
            | string
            | undefined;
          if (insertedId) {
            const list = perMap.get(mapRow.id) ?? [];
            list.push({
              job_id: insertedId,
              session_token: sessionToken,
              spec,
            });
            perMap.set(mapRow.id, list);
          }
          queued++;
        } catch (error) {
          this.logger.warn(
            `[auto-clips] match ${matchId} map ${mapRow.id} target ${targetSteamId} skipped: ${(error as Error)?.message}`,
          );
        }
      }
    }

    this.logger.log(
      `[auto-clips] match ${matchId} queued ${queued} recap job(s) (default visibility=${defaultVisibility})`,
    );

    // jobId is unique per call so re-runs never dedupe against a
    // prior completed job. Queue concurrency is 1.
    for (const matchMapId of perMap.keys()) {
      try {
        await this.batchQueue.add(
          BATCH_HIGHLIGHTS_JOB_NAME,
          { matchMapId },
          { jobId: `${matchMapId}-${Date.now()}` },
        );
        this.logger.log(
          `[auto-clips] match ${matchId} map ${matchMapId} → enqueued ClipRenderBatch`,
        );
      } catch (error) {
        this.logger.warn(
          `[auto-clips] match ${matchId} map ${matchMapId} enqueue failed: ${(error as Error)?.message}`,
        );
      }
    }
    return queued;
  }

  private async readSetting(name: string, fallback: string): Promise<string> {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name },
        value: true,
      },
    });
    return settings_by_pk?.value ?? fallback;
  }

  private async readBoolSetting(
    name: string,
    fallback: boolean,
  ): Promise<boolean> {
    const raw = await this.readSetting(name, fallback ? "true" : "false");
    return raw === "true" || raw === "1";
  }

  public async buildPresetSpec(
    matchMapId: string,
    targetSteamId: string,
    preset: "knife" | "multikills" | "best_round" | "recap",
    output: { resolution: "720p" | "1080p"; fps: 30 | 60 } = {
      resolution: "1080p",
      fps: 60,
    },
    title?: string,
    targetName?: string,
  ): Promise<ClipSpec> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: { where: { match_map_id: { _eq: matchMapId } }, limit: 1 },
        id: true,
        tick_rate: true,
        total_ticks: true,
        kills: true,
        round_ticks: true,
      },
    });
    const demo = match_map_demos?.[0];
    if (!demo) {
      throw new Error(
        `no parsed demo for match_map ${matchMapId} — try opening the demo first to trigger parse`,
      );
    }
    const tickRate = (demo.tick_rate as number) || 64;
    const totalTicks = (demo.total_ticks as number) || 0;
    const kills =
      (demo.kills as Array<{
        tick: number;
        killer?: string;
        victim?: string;
        weapon?: string;
        headshot?: boolean;
      }>) ?? [];
    const rounds =
      (demo.round_ticks as Array<{
        round: number;
        start_tick: number;
        end_tick: number;
      }>) ?? [];

    const myKills = kills.filter((k) => k.killer === targetSteamId);
    const lead = Math.round(tickRate * 5);
    const tail = Math.round(tickRate * 3);
    // Two kills within this gap join into one segment, otherwise cut.
    const CLUSTER_GAP_SECS = 10;
    const clusterGapTicks = Math.round(tickRate * CLUSTER_GAP_SECS);
    const clamp = (t: number) => Math.max(0, Math.min(t, totalTicks || t));

    const clusterKills = (
      ks: Array<{ tick: number }>,
    ): Array<{ start_tick: number; end_tick: number }> => {
      if (ks.length === 0) return [];
      const sorted = [...ks].sort((a, b) => a.tick - b.tick);
      const out: Array<{ start_tick: number; end_tick: number }> = [];
      let clusterStart = sorted[0].tick;
      let clusterEnd = sorted[0].tick;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].tick - clusterEnd;
        if (gap <= clusterGapTicks) {
          clusterEnd = sorted[i].tick;
          continue;
        }
        out.push({
          start_tick: clamp(clusterStart - lead),
          end_tick: clamp(clusterEnd + tail),
        });
        clusterStart = sorted[i].tick;
        clusterEnd = sorted[i].tick;
      }
      out.push({
        start_tick: clamp(clusterStart - lead),
        end_tick: clamp(clusterEnd + tail),
      });
      return out;
    };

    let segments: Array<{ start_tick: number; end_tick: number }> = [];
    const stats = {
      knifeKills: 0,
      multiKillBuckets: { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>,
      bestRoundKills: 0,
      recapKills: 0,
      usedFallback: false,
    };

    if (preset === "knife") {
      const knife = myKills.filter((k) =>
        (k.weapon ?? "").toLowerCase().includes("knife"),
      );
      stats.knifeKills = knife.length;
      segments = knife.map((k) => ({
        start_tick: clamp(k.tick - lead),
        end_tick: clamp(k.tick + tail),
      }));
    } else if (preset === "multikills") {
      for (const r of rounds) {
        const inRound = myKills.filter(
          (k) => k.tick >= r.start_tick && k.tick <= r.end_tick,
        );
        if (inRound.length < 2) continue;
        const bucket = Math.min(5, inRound.length);
        stats.multiKillBuckets[bucket] =
          (stats.multiKillBuckets[bucket] ?? 0) + 1;
        segments.push(...clusterKills(inRound));
      }
    } else if (preset === "best_round") {
      let best: {
        round: number;
        count: number;
        start: number;
        end: number;
      } | null = null;
      for (const r of rounds) {
        const count = myKills.filter(
          (k) => k.tick >= r.start_tick && k.tick <= r.end_tick,
        ).length;
        if (!best || count > best.count) {
          best = {
            round: r.round,
            count,
            start: r.start_tick,
            end: r.end_tick,
          };
        }
      }
      if (best && best.count > 0) {
        stats.bestRoundKills = best.count;
        const inRound = myKills
          .filter((k) => k.tick >= best!.start && k.tick <= best!.end)
          .sort((a, b) => a.tick - b.tick);
        segments = clusterKills(inRound);
      }
    } else if (preset === "recap") {
      segments = clusterKills(myKills);
      stats.recapKills = myKills.length;
    }

    // Fall back to a single best kill so the user still gets a clip,
    // and flag it so the title reflects that nothing matched the preset.
    if (segments.length === 0 && myKills.length > 0) {
      const fallback = myKills.find((k) => k.headshot) ?? myKills[0];
      segments = [
        {
          start_tick: clamp(fallback.tick - lead),
          end_tick: clamp(fallback.tick + tail),
        },
      ];
      stats.usedFallback = true;
    }

    if (segments.length === 0) {
      throw new Error(
        `no clip-worthy moments for ${targetSteamId} in this match — preset "${preset}" produced zero segments and the player has no kills to fall back on`,
      );
    }

    // Join segments within ~2s — otherwise cs2's re-seek leaves a
    // visible freeze on the concat boundary.
    segments.sort((a, b) => a.start_tick - b.start_tick);
    const joinGap = Math.round(tickRate * 2);
    const merged: Array<{
      start_tick: number;
      end_tick: number;
      pov_steam_id?: string;
    }> = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (last && s.start_tick <= last.end_tick + joinGap) {
        last.end_tick = Math.max(last.end_tick, s.end_tick);
      } else {
        merged.push({ ...s, pov_steam_id: targetSteamId });
      }
    }

    const MAX_SEGMENTS = 20;
    if (merged.length > MAX_SEGMENTS) {
      merged.length = MAX_SEGMENTS;
    }

    const playerLabel =
      targetName?.trim() || `Player ${targetSteamId.slice(-4)}`;
    const autoTitle = (() => {
      if (stats.usedFallback) {
        const presetLabel =
          preset === "best_round"
            ? "Best Round"
            : preset === "multikills"
              ? "Multi-Kills"
              : preset === "recap"
                ? "Match Recap"
                : "Knife Kills";
        return `${playerLabel} — Best Single Kill (no ${presetLabel.toLowerCase()} found)`;
      }
      if (preset === "knife") {
        const n = stats.knifeKills;
        return `${playerLabel} — ${n} Knife ${n === 1 ? "Kill" : "Kills"}`;
      }
      if (preset === "multikills") {
        const parts: string[] = [];
        for (const k of [5, 4, 3, 2]) {
          const n = stats.multiKillBuckets[k] ?? 0;
          if (n > 0) parts.push(`${n}× ${k}K`);
        }
        const summary = parts.length ? parts.join(", ") : "Multi-Kills";
        return `${playerLabel} — Multi-Kills (${summary})`;
      }
      if (preset === "best_round") {
        return `${playerLabel} — Best Round (${stats.bestRoundKills}K)`;
      }
      if (preset === "recap") {
        const segCount = merged.length;
        return `${playerLabel} — Match Recap (${stats.recapKills} kills · ${segCount} clip${segCount === 1 ? "" : "s"})`;
      }
      return `${playerLabel} — Highlights`;
    })();

    return {
      match_map_id: matchMapId,
      segments: merged,
      output: { format: "mp4", resolution: output.resolution, fps: output.fps },
      destination: "library",
      title: title ?? autoTitle,
      target_name: playerLabel,
    } as ClipSpec;
  }

  private validateSpec(spec: ClipSpec) {
    if (!spec || typeof spec !== "object") throw new Error("spec required");
    if (!spec.match_map_id) throw new Error("spec.match_map_id required");
    if (!Array.isArray(spec.segments) || spec.segments.length === 0) {
      throw new Error("at least one segment required");
    }
    if (spec.segments.length > 20) {
      throw new Error("too many segments (max 20)");
    }
    let totalTicks = 0;
    for (const seg of spec.segments) {
      if (
        typeof seg.start_tick !== "number" ||
        typeof seg.end_tick !== "number" ||
        seg.end_tick <= seg.start_tick
      ) {
        throw new Error("each segment needs start_tick < end_tick");
      }
      totalTicks += seg.end_tick - seg.start_tick;
    }
    if (totalTicks > 64 * 60 * 15) {
      throw new Error("clip too long (max ~15 minutes of demo time)");
    }
    if (!spec.output) throw new Error("spec.output required");
    if (spec.output.format !== "mp4") {
      throw new Error("only mp4 output is supported in v1");
    }
    if (
      spec.output.resolution !== "720p" &&
      spec.output.resolution !== "1080p"
    ) {
      throw new Error("output.resolution must be 720p or 1080p");
    }
    if (spec.output.fps !== 30 && spec.output.fps !== 60) {
      throw new Error("output.fps must be 30 or 60");
    }
    if (spec.destination !== "library" && spec.destination !== "download") {
      throw new Error("destination must be library or download");
    }
  }
}
