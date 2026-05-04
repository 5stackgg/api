import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { ClipSpec } from "./types/ClipSpec";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";

const STATUS_HISTORY_CAP = 50;

const IN_FLIGHT_STATUSES = ["queued", "rendering", "uploading"] as const;

@Injectable()
export class ClipsService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly s3: S3Service,
    private readonly gameStreamer: GameStreamerService,
  ) {}

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

  public async deleteClip(userSteamId: string, clipId: string) {
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
    if (String(row.user_steam_id) !== String(userSteamId)) {
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

    const { insert_match_clips_one } = await this.hasura.mutation({
      insert_match_clips_one: {
        __args: {
          object: {
            user_steam_id: userSteamId,
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
    const merged: Array<{ start_tick: number; end_tick: number }> = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (last && s.start_tick <= last.end_tick + joinGap) {
        last.end_tick = Math.max(last.end_tick, s.end_tick);
      } else {
        merged.push({ ...s });
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
    };
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
