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

// Job-name string the BullMQ producer uses, matching the worker
// class name. We deliberately use a string literal instead of
// importing BatchHighlightsRenderJob.name because the worker
// imports THIS service, and re-importing the worker here would
// create a load-time cycle that breaks NestJS's class-token
// metadata for the constructor params.
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

  // Resolve Steam persona names for a list of steamid64s via the
  // public ISteamUser/GetPlayerSummaries endpoint. Used as the
  // last-resort name source when the demo's userinfo string-table
  // doesn't carry a (steam_id, name) pair (rare — usually means a
  // truncated demo or an old parser binary). Steam persona ≠ in-game
  // name verbatim — players often play under a different handle —
  // but it's the right "who is this real human" answer for clip
  // titles when nothing else has it. Endpoint accepts up to 100 ids
  // per call; we batch.
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

  // Cancel an entire batch (one match_map's render queue) in a
  // single operator action. Distinct from cancelClipRender, which
  // targets one row.
  //
  // Order of operations matters:
  //   1. Mark all in-flight rows cancelled FIRST. The pod's
  //      inline-clip-render.sh checks status before each clip and
  //      bails on `cancelled`, so any clips not yet started are
  //      skipped naturally as the pod walks its CLIP_BATCH_JOBS env.
  //   2. Remove the BullMQ batch job. The watcher would otherwise
  //      keep redispatching the pod when it sees the k8s Job in
  //      "failed" state, even though the operator just told us to
  //      stop.
  //   3. Tear down the running pod. THIS is an authorised kill —
  //      the operator explicitly cancelled. We still kill via the
  //      same path the failed-pod cleanup uses, just with intent
  //      rather than reactivity.
  //
  // The pod COULD finish its current clip before we tell it to stop.
  // The status flip on remaining rows means subsequent clips skip;
  // the kill in (3) ensures the in-flight render also dies cleanly
  // rather than uploading a clip the user just told us to forget.
  public async cancelClipRenderBatch(matchMapId: string): Promise<number> {
    // 1. Cancel rows.
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

    // 2. Drop the BullMQ batch job. removeJobs returns {removed,
    //    failed_to_remove}; we only need to know it ran.
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

    // 3. Operator-authorised pod kill. Distinct from the watcher's
    //    "never preempt running pods" rule — that's about avoiding
    //    accidental kills, not refusing them when the user asked.
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
    if (row.status === "done" || row.status === "error" || row.status === "cancelled") {
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
    // Default 1× (real-time). The pod's GPU only renders ~60fps native,
    // so any >1× capture loses unique frames and the ffmpeg slowdown
    // turns the result into slow-motion. Operators with a stronger GPU
    // can opt in via the env var.
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

  // Mutate clip metadata after the render is done. Owner-only;
  // raises if the clip belongs to someone else. Each field is
  // optional — undefined means "don't touch this column" so the
  // caller can rename a clip without flipping its visibility, etc.
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
      // Empty string -> null so the UI can fall back to "Untitled".
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
      // Allow explicit null to clear the field. For a non-null value
      // we have to verify a players row exists — the FK rejects any
      // steamid that's never logged into 5stack, and the demo's
      // parser can produce steamids of bot/world/non-registered
      // players. Silent null vs. throw: silent matches the "best
      // effort attribution" model — clip still saves with no link.
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
    // Owners can delete their own clips. Operators (streamer-rank+,
    // checked at the controller layer and forwarded as
    // actorIsOperator=true) can delete ANY clip — they manage the
    // platform's library from /manage-clips, where most rows are
    // owned by the match organizer of the originating match, not by
    // the operator viewing the page.
    if (
      !actorIsOperator &&
      String(row.user_steam_id) !== String(userSteamId)
    ) {
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
  ): Promise<{ id: string; user_steam_id: string; match_map_id: string } | null> {
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

  // Patch the title on a queued render's spec. The pod calls this
  // after GSI resolves the player's actual name (the api builds the
  // title at enqueue time with only steam_id available, so it ends
  // up "Player NNNN — Best Round (NK)" until the pod overrides).
  // We read the existing spec, swap in the new title, and write back —
  // finalizeClipUpload's later read of spec.title picks up the new
  // value unchanged.
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

  // Cheap status read for the pod's pre-render cancellation check.
  // Returns just the status string so we don't ship the full row's
  // jsonb spec back to a hot poll loop.
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
    if (typeof body.progress === "number" && body.progress >= 0 && body.progress <= 1) {
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
    // Preset renders stamp pov_steam_id on every segment with the
    // target player's steamid64. Manual-trim renders leave it
    // undefined. Use the first segment's pov as the clip's "about"
    // player — by-design all preset segments share the same target,
    // and manual trims don't have one.
    //
    // target_steam_id FK references players(steam_id). For auto-clip
    // batches we already upsert a `players` row at queue time (with
    // the demo / Steam-persona resolved name) so the FK is satisfied
    // here. Manual / one-off renders may still reference a pov that
    // was never imported — try an upsert with the spec's target_name
    // so the FK lands either way; if even that fails (no name to use),
    // fall back to null so the clip insert doesn't blow up.
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
            visibility: "private",
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

  // Generate match-recap clips for every player who got kills in a
  // match. Two callers:
  //   - match_events on status -> Finished, gated by the
  //     `auto_generate_match_clips` setting (background auto-gen).
  //   - The "Create Player Highlights" admin button on a match,
  //     which passes { force: true } to bypass the setting and
  //     produce highlights on demand.
  //
  // Each (match_map, killer) pair becomes ONE queued clip_render_jobs
  // row. Pod orchestration that drains the queue is out of scope —
  // this method just persists the spec rows so the same render
  // pipeline can pick them up later.
  //
  // Returns the number of jobs created so the caller can log it.
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
      "private",
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

    // Clear out the prior batch's clip_render_jobs rows for these
    // match_maps before queueing fresh ones. Pressing "Create Player
    // Highlights" again means "redo this batch from scratch" — the
    // operator does not want last attempt's failed rows polluting the
    // queue panel, and they don't want the new batch's progress
    // commingled with the previous attempt under the same match_map_id
    // group. The actual match_clips artifacts (the rendered videos
    // from successful prior runs) live in a separate table and stay
    // intact; we're only removing the per-render bookkeeping rows.
    const matchMapIds = (match.match_maps ?? []).map((m: any) =>
      String(m.id),
    );
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
    // Track jobs queued PER match_map so we can dispatch one batch
    // pod per map afterwards. Multi-map matches → multiple pods (one
    // per .dem file), each pod loads cs2 + that demo once and renders
    // every player's recap against the running cs2 instance.
    const perMap = new Map<
      string,
      Array<{ job_id: string; session_token: string; spec: any }>
    >();

    // Resolve player names for every killer across all maps so the
    // queued clip titles read "CabessaaR — Best Round (4K)" instead
    // of "Player 6843 — Best Round (4K)" the moment the rows hit the
    // /manage-highlights/queue subscription.
    //
    // The demo file IS the source of truth — it's the same data the
    // streamer pod's CS2 GSI replay reports the moment a render
    // starts. If a steam_id is missing from `match_map_demos.players`
    // it means the demo was parsed by an older parser binary that
    // didn't capture every userinfo string-table entry. We force a
    // re-parse for any map_demo missing a killer's name, then re-
    // resolve. We do NOT fall back to a 3rd table — the demo always
    // has it.
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

    // Anyone we couldn't resolve from the demo is almost always a sign
    // the demo's `players` jsonb was stale — re-parse the affected
    // map_demo and try again. ensureParsedById short-circuits on
    // already-parsed rows so we use reparseById to FORCE a fresh run
    // through the (now fixed) Go parser.
    if (unresolved.length > 0) {
      const mapsNeedingReparse = (match.match_maps ?? []).filter(
        (m: any) => {
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
        },
      );
      const allMissing = unresolved.length === allKillers.size;
      this.logger.warn(
        `[auto-clips] match ${matchId} has ${unresolved.length} killer steam_id(s) missing from demo.players (${unresolved.join(", ")})${allMissing ? " — ALL killers missing usually means the running demo-parser image is older than the parser-side userinfo handler fix; rebuild + redeploy demo-parser to recapture names from the demo file" : ""} — re-parsing ${mapsNeedingReparse.length} map_demo(s) to refresh names`,
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
      // Re-fetch the match with refreshed demo.players + kills.
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
        // Also refresh kills/round_ticks so buildPresetSpec sees the
        // fresh rows when it queries by match_map_id below.
        match.match_maps = refreshed.match_maps;
      }
      unresolved = Array.from(allKillers).filter(
        (sid) => !nameByStId.has(sid),
      );
      if (unresolved.length > 0) {
        // Still missing after re-parse — most often this means the
        // running demo-parser image is older than the parser-side
        // PlayerInfo handler fix, or the demo file genuinely doesn't
        // carry the names. Either way, fall back to Steam's public
        // persona endpoint: we have the steamid64 right here and the
        // user's question on this exact failure mode was "do we have
        // steam ids? we could look them up via Steam instead?".
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

    // Make sure every killer has a `players` row before we queue the
    // clip_render_jobs. The match_clips.target_steam_id column has a
    // FK to players(steam_id) — without a row here, finalizeClipUpload
    // has to drop target_steam_id to avoid blowing up the insert,
    // which is exactly why guest players (steam_ids that never logged
    // into 5stack) ended up with no clickable attribution on their
    // clips. Upserting with update_columns:[] is a no-op for
    // already-existing players, so we don't trample real users'
    // profile data.
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
      const kills = (demo?.kills as Array<{ killer?: string }> | undefined) ?? [];
      if (!demo || kills.length === 0) continue;

      // Unique killers in this map. For each, build the recap spec
      // and queue one job. Skipping the buildPresetSpec error path
      // (no kills) is fine since we already filtered to killers
      // who appear in this map's kills array.
      const killers = new Set<string>();
      for (const k of kills) if (k.killer) killers.add(k.killer);

      for (const targetSteamId of killers) {
        try {
          // best_round = the single round the player did the most
          // damage in, rendered as ONE clip (clusterKills inside
          // that round produces a single tight segment when the
          // kills are close together, which is the typical case).
          // Auto-gen on match completion is "give me each player's
          // single best round" — NOT every round they got kills in.
          const spec = await this.buildPresetSpec(
            mapRow.id,
            targetSteamId,
            "best_round",
            { resolution: "1080p", fps: 60 },
            undefined,
            // Real name when we have one; falls through to
            // "Player <suffix>" inside buildPresetSpec when not.
            nameByStId.get(targetSteamId),
          );
          // Force visibility based on operator setting.
          (spec as any).destination = "library";
          // Queue the job. Naming the match's organizer as the owner
          // so the clips appear under their library — they had
          // implicit consent to render on their match.
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
                  // Pre-stamp the batch pod's k8s_job_name so the
                  // row's audit trail points at the pod that'll
                  // process it. The dispatch step right after queueing
                  // creates that pod under this exact name.
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
          // Per-target failures shouldn't tank the whole batch —
          // logs let an admin see who got skipped + why.
          this.logger.warn(
            `[auto-clips] match ${matchId} map ${mapRow.id} target ${targetSteamId} skipped: ${(error as Error)?.message}`,
          );
        }
      }
    }

    this.logger.log(
      `[auto-clips] match ${matchId} queued ${queued} recap job(s) (default visibility=${defaultVisibility})`,
    );

    // Enqueue one BullMQ batch job per match_map. The worker
    // (BatchHighlightsRenderJob) owns pod lifecycle, polling, and
    // pod-state observation — this method just produces work.
    //
    // jobId is unique per call (matchMapId + ms timestamp) so every
    // press of "Create Player Highlights" produces a fresh BullMQ
    // job that re-renders. We previously used matchMapId so re-runs
    // would dedupe to the existing job, but combined with the 24h
    // age-based retention that left re-runs silently shadowed by
    // the prior completed job. Queue concurrency is 1, so two
    // simultaneous requests still serialise — they don't race for
    // the same GPU.
    for (const matchMapId of perMap.keys()) {
      try {
        // BullMQ job NAME must match the worker class name —
        // utilities/QueueProcessors's QueueProcessor dispatches via
        // `_jobs[job.name]` which is keyed by `target.name` from the
        // @UseQueue decorator. Adding under any other name throws
        // "Nest could not find given element" at consume time.
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

  // Highlight presets — turn a player + intent ("their knife kills",
  // "their multikills", etc.) into a multi-segment ClipSpec the
  // existing render path consumes. The heavy lifting is segment-merge:
  // adjacent kills inside the same round get coalesced so we don't
  // render four 8-second clips for a 1v4 (would look like a stutter).
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
    // Two consecutive kills with ≤ this much "dead time" between them
    // get joined into one continuous segment. Above the threshold we
    // cut and start a new segment for the next kill cluster — that
    // skips the running-around-doing-nothing in between. 10s is a
    // sweet spot: it preserves trade kills + back-to-back engagements
    // without leaving long gaps where the player's just rotating.
    const CLUSTER_GAP_SECS = 10;
    const clusterGapTicks = Math.round(tickRate * CLUSTER_GAP_SECS);
    const clamp = (t: number) => Math.max(0, Math.min(t, totalTicks || t));

    // Cluster a sorted-by-tick kill list into segments. Each output
    // segment spans [first_kill - lead, last_kill + tail] within the
    // cluster. If lead/tail of an adjacent segment overlap they get
    // merged downstream — but the gap-based splitting prevents the
    // common "wait 30s for next kill" dead air.
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
    // Stats we accumulate while building so we can name the clip
    // honestly afterwards (e.g. "Multi-Kills — 2× 3K, 1× 4K" instead
    // of a generic "multikills"). Also lets us tell the user we fell
    // back to a single kill when the preset matched nothing.
    const stats = {
      knifeKills: 0,
      multiKillBuckets: { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>,
      bestRoundKills: 0,
      recapKills: 0,
      usedFallback: false,
    };

    if (preset === "knife") {
      // Knife kills are punchy on their own — skip clustering, give
      // each one a tight personal window (the 5s lead is enough to
      // see the approach, 3s tail catches the celebration / death).
      const knife = myKills.filter((k) =>
        (k.weapon ?? "").toLowerCase().includes("knife"),
      );
      stats.knifeKills = knife.length;
      segments = knife.map((k) => ({
        start_tick: clamp(k.tick - lead),
        end_tick: clamp(k.tick + tail),
      }));
    } else if (preset === "multikills") {
      // Frag-montage style: one segment per kill cluster, never the
      // whole round. A 4k with kills evenly spaced becomes 4 short
      // clips fading into each other; a 4k with 3 back-to-back kills
      // + a delayed cleanup becomes 2 clips. The "running around for
      // 30s between kills" never makes it into the output.
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
      let best: { round: number; count: number; start: number; end: number } | null =
        null;
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
        // Frag-montage style — one segment per kill cluster within
        // the best round. A 2K with 15s between kills becomes 2
        // short clips, NOT one 20s segment with running-around in
        // the middle.
        const inRound = myKills
          .filter((k) => k.tick >= best!.start && k.tick <= best!.end)
          .sort((a, b) => a.tick - b.tick);
        segments = clusterKills(inRound);
      }
    } else if (preset === "recap") {
      // Every kill the player got, clustered globally. This naturally
      // skips between rounds (long gap = new segment), within rounds
      // (long approach = new segment), and across map halves.
      segments = clusterKills(myKills);
      stats.recapKills = myKills.length;
    }

    // Fallback: if the chosen preset produced nothing, drop down to
    // "single best kill" (HS preferred) so the user still gets a
    // clip — but flag the fallback so the title makes it obvious
    // ("…no multi-kills found" rather than presenting a 1k as a
    // multi-kill, which is what was confusing about the previous
    // behavior).
    if (segments.length === 0 && myKills.length > 0) {
      const fallback =
        myKills.find((k) => k.headshot) ?? myKills[0];
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

    // Merge overlapping / adjacent segments. Two segments that touch
    // within ~2s get joined — otherwise the concat produces a visible
    // freeze on the boundary (cs2 has to reseek + re-pause).
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
        // Tag every segment with the target so the render pod can
        // `spec_player_by_accountid <id>` before play — guarantees
        // we capture the player's POV even though cs2 may have
        // auto-switched to someone else when we last left the demo.
        merged.push({ ...s, pov_steam_id: targetSteamId });
      }
    }

    // Hard cap (validateSpec rejects >20 segments / >15min). Trim from
    // the lowest-impact end first — for recap/multikills that's the
    // earliest rounds; for knife it's the earliest kills. We just
    // truncate from the end to keep the recency bias.
    const MAX_SEGMENTS = 20;
    if (merged.length > MAX_SEGMENTS) {
      merged.length = MAX_SEGMENTS;
    }

    // Build a human-readable title from what actually got rendered.
    // Naming the clip after the *result* (not just the preset) makes
    // it obvious in the library why a "Multi-Kills" clip only has
    // one kill — because there were no multi-kills to render.
    const playerLabel =
      targetName?.trim() || `Player ${targetSteamId.slice(-4)}`;
    const autoTitle = (() => {
      if (stats.usedFallback) {
        const presetLabel =
          preset === "best_round" ? "Best Round" :
          preset === "multikills" ? "Multi-Kills" :
          preset === "recap" ? "Match Recap" :
          "Knife Kills";
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
      // target_name is exposed separately so the queue UI can show the
      // player attribution even when the title is overridden by the
      // operator. Falls back to the same "Player NNNN" placeholder the
      // title path uses, which the streamer pod still patches via GSI.
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
    if (spec.output.resolution !== "720p" && spec.output.resolution !== "1080p") {
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
