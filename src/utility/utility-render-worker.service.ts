import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { UtilityPracticeService } from "./utility-practice.service";
import { UtilityRendersService } from "./utility-renders.service";
import { UtilityRenderSpec } from "./types/UtilityRenderSpec";

export type UtilityRenderWorkerJob = {
  job_id: string;
  token: string;
  spec: UtilityRenderSpec & { plugin_runtime: string };
};

/**
 * What a render pod does next. It asks between lineups, so the queue it
 * drains is the one that exists then rather than the one it was booked with:
 *   render -- film these, on the map it is already on
 *   map    -- the server is changing level; come back once spawned on it
 *   wait   -- nothing to do yet, ask again
 *   done   -- nothing coming; exit and give the server and the GPU back
 */
export type UtilityRenderWorkerNext =
  | { action: "render"; jobs: Array<UtilityRenderWorkerJob> }
  | { action: "map"; map_name: string }
  | { action: "wait"; seconds: number }
  | { action: "done" };

type QueuedRow = { id: string; map_name: string };

@Injectable()
export class UtilityRenderWorkerService {
  // A pod with an empty queue waits this long for the next render before it
  // gives its server back. Booting the pair again costs minutes; a moderator
  // working down a list presses the next one well inside this.
  public static readonly IDLE_SECONDS = 75;
  public static readonly POLL_SECONDS = 5;
  // A level that has not come up in this long is not coming. The pod is told
  // to stop, and the batch job books the map a server of its own.
  public static readonly MAP_CHANGE_TIMEOUT_SECONDS = 240;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly renders: UtilityRendersService,
    private readonly practice: UtilityPracticeService,
  ) {}

  public static idleKey(sessionId: string): string {
    return `utility:render:idle:${sessionId}`;
  }

  public async next(matchId: string): Promise<UtilityRenderWorkerNext> {
    const session = await this.practice.renderSessionForMatch(matchId);

    if (!session || session.status !== "Ready" || !session.render_job_name) {
      return { action: "done" };
    }

    const tag = `[nade-renders ${session.id}]`;

    // The pod asking is the pod saying it is still there, which is what its
    // GPU is held on.
    await this.practice.touchRenderPod(session.id);

    if (session.map_changing_seconds !== null) {
      if (
        session.map_changing_seconds >
        UtilityRenderWorkerService.MAP_CHANGE_TIMEOUT_SECONDS
      ) {
        this.logger.warn(
          `${tag} ${session.map_name} never finished loading — stopping the pod`,
        );
        return { action: "done" };
      }
      return { action: "wait", seconds: UtilityRenderWorkerService.POLL_SECONDS };
    }

    const connection = await this.practice.renderConnection(session.id);

    if (!connection) {
      return { action: "done" };
    }

    let queued = await this.unclaimed();
    const here = queued.filter((row) => row.map_name === session.map_name);

    if (here.length > 0) {
      await this.cache.forget(UtilityRenderWorkerService.idleKey(session.id));

      // The library the plugin serves the pod is the session's rows, and it
      // re-reads it every time the pod stages a lineup. So the whole of this
      // map's queue goes on the session now.
      await this.renders.attachSession(
        here.map((row) => row.id),
        session.id,
      );

      const row = await this.renders.handToPod(here[0].id, {
        sessionId: session.id,
        jobName: session.render_job_name,
        nodeId: connection.node_id,
      });

      if (!row) {
        return { action: "wait", seconds: 1 };
      }

      const waiting = here.slice(1).map((other) => other.id);

      // The row is the pod's from here, so nothing after this may stop it
      // being sent: a row handed over and never delivered sits in flight
      // until the pod exits.
      try {
        await this.renders.stampBootStage(waiting, "waiting_turn", null, {
          once: true,
        });
      } catch (error) {
        this.logger.warn(
          `${tag} could not mark the rows waiting behind ${row.id}: ${(error as Error)?.message}`,
        );
      }

      this.logger.log(
        `${tag} handed ${row.id} to ${session.render_job_name} (${waiting.length} more on ${session.map_name})`,
      );

      return {
        action: "render",
        jobs: [
          {
            job_id: row.id,
            token: row.session_token,
            spec: { ...row.spec, plugin_runtime: connection.plugin_runtime },
          },
        ],
      };
    }

    while (queued.length > 0) {
      const target = queued[0].map_name;
      const moving = queued
        .filter((row) => row.map_name === target)
        .map((row) => row.id);

      // No server can ever be booked on it, here or anywhere, and that does
      // not change by waiting. Left queued it would be the head of the queue
      // for every pod after this one, with every other map stuck behind it.
      if (!(await this.practice.canPracticeOn(target))) {
        this.logger.warn(
          `${tag} ${target} is not available for practice — failing its ${moving.length} render(s)`,
        );
        await this.renders.failRenders(
          moving,
          `${target} is not available for practice, so no server can be booked on it`,
        );
        queued = queued.filter((row) => row.map_name !== target);
        continue;
      }

      await this.cache.forget(UtilityRenderWorkerService.idleKey(session.id));

      // A level change is the one point where stopping costs nothing that has
      // been started. Somebody waiting to go live gets the GPU; the queue
      // books again once one is free.
      if (await this.liveStreamWaiting()) {
        this.logger.log(
          `${tag} a live stream wants the GPU — stopping before ${target}`,
        );
        return { action: "done" };
      }

      // On the session before the level changes: the plugin fetches its
      // library as the new map comes up.
      await this.renders.attachSession(moving, session.id);

      try {
        await this.practice.changeRenderMap(session.id, target);
      } catch (error) {
        this.logger.warn(
          `${tag} could not move to ${target} (${(error as Error)?.message}) — stopping the pod`,
        );
        return { action: "done" };
      }

      try {
        await this.renders.stampBootStage(moving, `changing_map:${target}`);
        await this.renders.stampBootStage(
          queued.filter((row) => row.map_name !== target).map((row) => row.id),
          "waiting_for_map",
          null,
          { once: true },
        );
      } catch (error) {
        this.logger.warn(
          `${tag} could not mark the rows moving to ${target}: ${(error as Error)?.message}`,
        );
      }

      return { action: "map", map_name: target };
    }

    return this.idle(session.id, tag);
  }

  private async idle(
    sessionId: string,
    tag: string,
  ): Promise<UtilityRenderWorkerNext> {
    const key = UtilityRenderWorkerService.idleKey(sessionId);

    // Somebody is waiting for a GPU to go live on. A pod with nothing to film
    // is not a reason to keep them waiting.
    if (await this.liveStreamWaiting()) {
      await this.cache.forget(key);
      this.logger.log(`${tag} queue empty and a live stream wants the GPU`);
      return { action: "done" };
    }

    const since = Number(await this.cache.get(key));

    if (!Number.isFinite(since) || since <= 0) {
      await this.cache.put(
        key,
        Date.now(),
        UtilityRenderWorkerService.IDLE_SECONDS * 4,
      );
      return { action: "wait", seconds: UtilityRenderWorkerService.POLL_SECONDS };
    }

    if (Date.now() - since < UtilityRenderWorkerService.IDLE_SECONDS * 1000) {
      return { action: "wait", seconds: UtilityRenderWorkerService.POLL_SECONDS };
    }

    await this.cache.forget(key);
    this.logger.log(`${tag} queue empty — releasing the pod`);
    return { action: "done" };
  }

  // Queued and nobody's yet, in the order the queue films.
  private async unclaimed(): Promise<Array<QueuedRow>> {
    return this.postgres.query<Array<QueuedRow>>(
      `SELECT r.id::text AS id, r.map_name
         FROM public.utility_lineup_renders r
        WHERE r.status = 'queued'
          AND r.paused = false
          AND r.k8s_job_name IS NULL
        ORDER BY r.sort_index ASC, r.created_at ASC`,
    );
  }

  private async liveStreamWaiting(): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ waiting: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
           FROM public.match_streams
          WHERE is_game_streamer = true
            AND status = 'pending'
       ) AS waiting`,
    );
    return row?.waiting === true;
  }
}
