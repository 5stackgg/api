import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { randomUUID } from "crypto";
import { Queue } from "bullmq";
import { PostgresService } from "src/postgres/postgres.service";
import { CacheService } from "src/cache/cache.service";
import { RconService } from "src/rcon/rcon.service";
import { FileManagerService } from "src/file-manager/file-manager.service";
import { User } from "src/auth/types/User";
import { DedicatedServersService } from "./dedicated-servers.service";
import { DedicatedServerQueues } from "./enums/DedicatedServerQueues";

export type ServerMigrationNode = {
  id: string;
  label: string | null;
  enabled: boolean;
  status: string;
  node_ip: string | null;
  update_status: string | null;
  build_id: number | null;
  csgo_build_id: number | null;
  disk_available_gb: number | null;
  available_dedicated_slot_count: number;
};

export type ServerMigrationServer = {
  id: string;
  game: string;
  enabled: boolean;
  is_dedicated: boolean;
  region: string | null;
  reserved_by_match_id: string | null;
  game_server_node_id: string | null;
};

export type ServerMigration = {
  id: string;
  server_id: string;
  from_game_server_node_id: string | null;
  to_game_server_node_id: string | null;
  status: string;
  with_files: boolean;
};

@Injectable()
export class DedicatedServerMigrationService {
  private static readonly GIB = 1024 * 1024 * 1024;
  private static readonly LOCK_TTL_SECONDS = 60;
  private static readonly HEARTBEAT_MS = 10 * 1000;
  private static readonly CANCEL_POLL_MS = 2 * 1000;
  private static readonly PROGRESS_EVERY_MS = 1000;
  private static readonly STALL_MS = 2 * 60 * 1000;
  private static readonly STOP_TIMEOUT_MS = 3 * 60 * 1000;
  private static readonly DEPLOY_WAIT_MS = 90 * 1000;
  private static readonly CANCEL_TTL_SECONDS = 60 * 60;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly rcon: RconService,
    private readonly fileManager: FileManagerService,
    private readonly dedicatedServers: DedicatedServersService,
    @InjectQueue(DedicatedServerQueues.ServerMigrations)
    private readonly queue: Queue,
  ) {}

  public static jobId(migrationId: string): string {
    return `migrate:${migrationId}`;
  }

  public static isNodeUp(node: ServerMigrationNode | undefined): boolean {
    return (
      !!node?.node_ip &&
      (node.status === "Online" || node.status === "NotAcceptingNewMatches")
    );
  }

  public static moveTargetIneligibility(
    node: ServerMigrationNode,
    server: Pick<ServerMigrationServer, "game" | "game_server_node_id">,
  ): string | null {
    const name = node.label || node.id;

    if (node.id === server.game_server_node_id) {
      return `The server is already on ${name}`;
    }
    if (!node.enabled) {
      return `${name} is disabled`;
    }
    if (!DedicatedServerMigrationService.isNodeUp(node)) {
      return `${name} is ${node.status === "Online" ? "unreachable" : node.status}`;
    }
    if (node.update_status) {
      return `${name} is updating CS2`;
    }
    if (server.game === "csgo" ? !node.csgo_build_id : !node.build_id) {
      return `${name} does not have ${server.game === "csgo" ? "CS:GO" : "CS2"} installed`;
    }
    if (node.available_dedicated_slot_count < 1) {
      return `${name} has no free server slots`;
    }

    return null;
  }

  private static lockKey(migrationId: string): string {
    return `server-migration:lock:${migrationId}`;
  }

  private static cancelKey(migrationId: string): string {
    return `server-migration:cancel:${migrationId}`;
  }

  public async requestMove(
    user: User,
    serverId: string,
    nodeId: string,
    withoutFiles: boolean,
  ): Promise<string> {
    const server = await this.getServer(serverId);

    if (!server?.is_dedicated || !server.game_server_node_id) {
      throw new BadRequestException(
        "Only a dedicated server running on a game server node can be moved",
      );
    }

    if (server.reserved_by_match_id) {
      throw new BadRequestException(
        "The server is hosting a match and cannot be moved until it ends",
      );
    }

    if (await this.hasPendingDemoUpload(serverId)) {
      throw new BadRequestException(
        "The server is still uploading a demo from its last match. Try again in a few minutes.",
      );
    }

    const nodes = await this.getNodes([server.game_server_node_id, nodeId]);
    const from = nodes.get(server.game_server_node_id);
    const to = nodes.get(nodeId);

    if (!to) {
      throw new NotFoundException("That game server node does not exist");
    }

    const ineligible = DedicatedServerMigrationService.moveTargetIneligibility(
      to,
      server,
    );

    if (ineligible) {
      throw new BadRequestException(ineligible);
    }

    const fromName = from?.label || server.game_server_node_id;
    const sourceUp = DedicatedServerMigrationService.isNodeUp(from);

    if (!sourceUp && !withoutFiles) {
      throw new BadRequestException(
        `${fromName} is offline, so the server's files cannot be copied. Move it without its files instead.`,
      );
    }

    if (sourceUp && withoutFiles) {
      throw new BadRequestException(
        `${fromName} is online, so the server's files can be moved with it`,
      );
    }

    await this.fileManager.serverDirectorySize(to.id, serverId);

    if (!withoutFiles) {
      const source = await this.fileManager.serverDirectorySize(
        server.game_server_node_id,
        serverId,
      );

      const gib = DedicatedServerMigrationService.GIB;

      if (
        to.disk_available_gb !== null &&
        to.disk_available_gb * gib < source.bytes * 1.1 + gib
      ) {
        throw new BadRequestException(
          `${to.label || to.id} does not have enough free disk space for this server's files`,
        );
      }
    }

    let migrationId: string;

    try {
      const [row] = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO server_migrations
           (server_id, from_game_server_node_id, to_game_server_node_id, with_files, requested_by_steam_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          serverId,
          server.game_server_node_id,
          to.id,
          !withoutFiles,
          user?.steam_id ?? null,
        ],
      );
      migrationId = row.id;
    } catch (error) {
      if (error?.code === "23505") {
        throw new BadRequestException("This server is already being moved");
      }
      throw error;
    }

    await this.queue.add(
      "MigrateDedicatedServer",
      { migrationId },
      {
        jobId: DedicatedServerMigrationService.jobId(migrationId),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.log(
      `[${serverId}] queued a move from ${server.game_server_node_id} to ${to.id}${withoutFiles ? " without its files" : ""}`,
    );

    return migrationId;
  }

  public async requestCancel(serverId: string): Promise<void> {
    const [queued] = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE server_migrations
          SET status = 'Canceled', finished_at = now()
        WHERE server_id = $1 AND status = 'Queued'
        RETURNING id`,
      [serverId],
    );

    if (queued) {
      await this.queue
        .remove(DedicatedServerMigrationService.jobId(queued.id))
        .catch((): undefined => undefined);
      return;
    }

    const [active] = await this.postgres.query<
      Array<{ id: string; status: string }>
    >(
      `SELECT id, status FROM server_migrations
        WHERE server_id = $1 AND status = ANY($2::text[])`,
      [serverId, DedicatedServersService.ACTIVE_MIGRATION_STATUSES],
    );

    if (!active) {
      throw new BadRequestException("This server is not being moved");
    }

    if (active.status === "Finalizing") {
      throw new BadRequestException(
        "The server is already switching to its new node and can no longer be canceled",
      );
    }

    await this.cache.put(
      DedicatedServerMigrationService.cancelKey(active.id),
      true,
      DedicatedServerMigrationService.CANCEL_TTL_SECONDS,
    );
  }

  public async run(migrationId: string): Promise<void> {
    const migration = await this.getMigration(migrationId);

    if (
      !migration ||
      !DedicatedServersService.ACTIVE_MIGRATION_STATUSES.includes(
        migration.status,
      )
    ) {
      return;
    }

    // A job redelivered while its first run still heartbeats is left alone;
    // once that run goes quiet the sweep recovers it.
    if (migration.status !== "Queued" && !migration.stale) {
      return;
    }

    const handled = await this.whileHolding(migration, async (abort) => {
      if (migration.status === "Queued") {
        await this.migrate(migration, abort);
        return;
      }

      await this.recover(migration);
    });

    if (!handled) {
      this.logger.warn(`[${migrationId}] move is already being handled`);
    }
  }

  public async sweep(): Promise<void> {
    const stale = await this.postgres.query<Array<ServerMigration>>(
      `SELECT id, server_id, from_game_server_node_id, to_game_server_node_id, status, with_files
         FROM server_migrations
        WHERE status = ANY($1::text[])
          AND updated_at < now() - interval '2 minutes'`,
      [DedicatedServersService.ACTIVE_MIGRATION_STATUSES],
    );

    for (const migration of stale) {
      if (migration.status === "Queued") {
        const job = await this.queue.getJob(
          DedicatedServerMigrationService.jobId(migration.id),
        );
        const state = await job?.getState();

        if (state && state !== "failed" && state !== "completed") {
          continue;
        }
      }

      try {
        await this.whileHolding(migration, () => this.recover(migration));
      } catch (error) {
        this.logger.error(
          `[${migration.server_id}] unable to recover an interrupted move`,
          error,
        );
      }
    }
  }

  private async whileHolding(
    migration: ServerMigration,
    task: (abort: AbortController) => Promise<void>,
  ): Promise<boolean> {
    const lockKey = DedicatedServerMigrationService.lockKey(migration.id);
    const token = randomUUID();

    if (
      !(await this.cache.acquireLock(
        lockKey,
        DedicatedServerMigrationService.LOCK_TTL_SECONDS,
        token,
      ))
    ) {
      return false;
    }

    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.heartbeat(migration, lockKey, token, abort);
    }, DedicatedServerMigrationService.HEARTBEAT_MS);

    try {
      await task(abort);
      return true;
    } finally {
      clearInterval(heartbeat);

      if ((await this.cache.getRaw(lockKey)) === token) {
        await this.cache.forget(lockKey);
      }
    }
  }

  private async migrate(
    migration: ServerMigration,
    abort: AbortController,
  ): Promise<void> {
    const serverId = migration.server_id;
    const cancelKey = DedicatedServerMigrationService.cancelKey(migration.id);

    const cancelPoll = setInterval(() => {
      void this.cache.has(cancelKey).then((canceled) => {
        if (canceled) {
          abort.abort(new Error("The move was canceled"));
        }
      });
    }, DedicatedServerMigrationService.CANCEL_POLL_MS);

    let committed = false;

    try {
      if (!(await this.transition(migration.id, "Queued", "Stopping"))) {
        return;
      }

      await this.stop(migration, abort.signal);

      if (migration.with_files) {
        await this.transfer(migration, abort);
      } else {
        await this.fileManager.deleteServerDirectory(
          migration.to_game_server_node_id,
          serverId,
        );
      }

      clearInterval(cancelPoll);

      if (await this.cache.has(cancelKey)) {
        abort.abort(new Error("The move was canceled"));
      }

      DedicatedServerMigrationService.throwIfAborted(abort.signal);

      await this.commit(migration);
      committed = true;

      await this.complete(migration, await this.afterCommit(migration));
    } catch (error) {
      clearInterval(cancelPoll);

      if (committed) {
        this.logger.error(
          `[${serverId}] move finished with an error after switching nodes`,
          error,
        );
        await this.complete(migration, [
          `The server switched nodes but the move did not finish cleanly: ${DedicatedServerMigrationService.errorMessage(error, abort.signal)}`,
        ]);
        return;
      }

      const canceled = await this.cache.has(cancelKey);

      if (!canceled) {
        this.logger.error(`[${serverId}] move failed`, error);
      }

      await this.rollback(
        migration,
        canceled ? "Canceled" : "Failed",
        canceled
          ? null
          : DedicatedServerMigrationService.errorMessage(error, abort.signal),
      );
    } finally {
      clearInterval(cancelPoll);
      await this.cache.forget(cancelKey);
    }
  }

  private async stop(
    migration: ServerMigration,
    signal: AbortSignal,
  ): Promise<void> {
    const serverId = migration.server_id;
    const server = await this.getServer(serverId);

    const detached = await this.cache.lock(
      `assign-dedicated-server:${server.region}`,
      async () => {
        const rows = await this.postgres.query<Array<unknown>>(
          `UPDATE servers SET connected = false
            WHERE id = $1 AND reserved_by_match_id IS NULL
            RETURNING id`,
          [serverId],
        );

        return rows.length > 0;
      },
    );

    if (!detached) {
      throw new Error("The server is hosting a match");
    }

    if (await this.hasPendingDemoUpload(serverId)) {
      throw new Error(
        "The server is still uploading a demo from its last match",
      );
    }

    await this.dedicatedServers.rebuildDedicatedServer(serverId, false);

    const nodes = await this.getNodes([migration.from_game_server_node_id]);

    await this.dedicatedServers.waitForDedicatedServerStopped(serverId, {
      acceptTerminating: !DedicatedServerMigrationService.isNodeUp(
        nodes.get(migration.from_game_server_node_id),
      ),
      timeoutMs: DedicatedServerMigrationService.STOP_TIMEOUT_MS,
    });

    const [{ reserved_by_match_id }] = await this.postgres.query<
      Array<{ reserved_by_match_id: string | null }>
    >(`SELECT reserved_by_match_id FROM servers WHERE id = $1`, [serverId]);

    if (reserved_by_match_id) {
      throw new Error("The server was given a match while it was stopping");
    }

    await this.rcon.disconnect(serverId);

    DedicatedServerMigrationService.throwIfAborted(signal);
  }

  private async transfer(
    migration: ServerMigration,
    abort: AbortController,
  ): Promise<void> {
    const serverId = migration.server_id;
    const fromId = migration.from_game_server_node_id;
    const toId = migration.to_game_server_node_id;

    if (!(await this.transition(migration.id, "Stopping", "Transferring"))) {
      throw new Error("The move was taken over by another worker");
    }

    const nodes = await this.getNodes([fromId]);

    if (!DedicatedServerMigrationService.isNodeUp(nodes.get(fromId))) {
      throw new Error(
        `${nodes.get(fromId)?.label || fromId} went offline, so the server's files cannot be copied. Move it without its files instead.`,
      );
    }

    const source = await this.fileManager.serverDirectorySize(fromId, serverId);

    const warnings = source.skipped.map(
      (entry) =>
        `Left ${entry} behind: it is a link pointing outside the server's files, a link through another link, or a special file`,
    );

    await this.postgres.query(
      `UPDATE server_migrations
          SET bytes_total = $2, entries_total = $3, warnings = warnings || $4::jsonb
        WHERE id = $1`,
      [
        migration.id,
        source.archiveBytes,
        source.entries,
        JSON.stringify(warnings),
      ],
    );

    if (!source.exists) {
      await this.fileManager.deleteServerDirectory(toId, serverId);
      return;
    }

    let lastByteAt = Date.now();
    let lastWriteAt = 0;

    const stall = setInterval(() => {
      if (Date.now() - lastByteAt > DedicatedServerMigrationService.STALL_MS) {
        abort.abort(new Error("The transfer stalled"));
      }
    }, 5000);

    try {
      await this.fileManager.relayServerDirectory(fromId, toId, serverId, {
        signal: abort.signal,
        onProgress: (bytesDone, bytesTotal) => {
          lastByteAt = Date.now();

          if (
            lastByteAt - lastWriteAt <
            DedicatedServerMigrationService.PROGRESS_EVERY_MS
          ) {
            return;
          }

          lastWriteAt = lastByteAt;

          void this.postgres
            .query(
              `UPDATE server_migrations
                  SET bytes_done = $2, bytes_total = GREATEST(COALESCE(bytes_total, 0), $3)
                WHERE id = $1 AND status = 'Transferring'`,
              [migration.id, bytesDone, bytesTotal],
            )
            .catch((): undefined => undefined);
        },
      });
    } finally {
      clearInterval(stall);
    }
  }

  private async commit(migration: ServerMigration): Promise<void> {
    await this.postgres.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE server_migrations
            SET status = 'Finalizing', bytes_done = GREATEST(bytes_done, COALESCE(bytes_total, 0))
          WHERE id = $1 AND status IN ('Stopping', 'Transferring')`,
        [migration.id],
      );

      if (rowCount !== 1) {
        throw new Error("The move was taken over by another worker");
      }

      await client.query(
        `UPDATE servers SET game_server_node_id = $2 WHERE id = $1`,
        [migration.server_id, migration.to_game_server_node_id],
      );
    });

    this.logger.log(
      `[${migration.server_id}] switched to ${migration.to_game_server_node_id}`,
    );
  }

  private async afterCommit(
    migration: ServerMigration,
  ): Promise<Array<string>> {
    const serverId = migration.server_id;
    const warnings: Array<string> = [];
    const server = await this.getServer(serverId);

    if (
      server.enabled &&
      !(await this.dedicatedServers.waitForDeployment(
        serverId,
        DedicatedServerMigrationService.DEPLOY_WAIT_MS,
      )) &&
      !(await this.dedicatedServers.rebuildDedicatedServer(serverId, true))
    ) {
      warnings.push(
        `The server did not start on ${migration.to_game_server_node_id}. Check its logs.`,
      );
    }

    if (migration.with_files) {
      try {
        await this.fileManager.deleteServerDirectory(
          migration.from_game_server_node_id,
          serverId,
        );
      } catch (error) {
        warnings.push(
          `The server's old files could not be removed from ${migration.from_game_server_node_id}: ${DedicatedServerMigrationService.errorMessage(error)}`,
        );
      }
    }

    return warnings;
  }

  private async rollback(
    migration: ServerMigration,
    status: "Failed" | "Canceled",
    error: string | null,
  ): Promise<void> {
    const serverId = migration.server_id;

    const ended = await this.postgres.query<Array<unknown>>(
      `UPDATE server_migrations SET status = $2, error = $3, finished_at = now()
        WHERE id = $1 AND status = ANY($4::text[])
        RETURNING id`,
      [
        migration.id,
        status,
        error,
        DedicatedServersService.ACTIVE_MIGRATION_STATUSES,
      ],
    );

    const server = await this.getServer(serverId);

    if (server?.game_server_node_id !== migration.to_game_server_node_id) {
      await this.discardCopy(migration);
    }

    if (ended.length > 0 && server) {
      await this.restoreOnSource(server);
    }
  }

  private async discardCopy(migration: ServerMigration): Promise<void> {
    const toId = migration.to_game_server_node_id;
    const nodes = await this.getNodes([toId]);

    if (!DedicatedServerMigrationService.isNodeUp(nodes.get(toId))) {
      return;
    }

    await this.fileManager
      .deleteServerDirectory(toId, migration.server_id)
      .catch((cleanupError) => {
        this.logger.warn(
          `[${migration.server_id}] unable to remove a partial copy from ${toId}: ${DedicatedServerMigrationService.errorMessage(cleanupError)}`,
        );
      });
  }

  // Only brings the server back when nothing is running it. A move that
  // failed before it stopped the server leaves it serving, match and all.
  private async restoreOnSource(server: ServerMigrationServer): Promise<void> {
    if (!server.enabled) {
      return;
    }

    try {
      if (!(await this.dedicatedServers.deploymentExists(server.id))) {
        await this.dedicatedServers.rebuildDedicatedServer(server.id, true);
      }
    } catch (error) {
      this.logger.error(
        `[${server.id}] unable to bring the server back after a failed move`,
        error,
      );
    }
  }

  private async recover(migration: ServerMigration): Promise<void> {
    const server = await this.getServer(migration.server_id);

    if (
      server &&
      server.game_server_node_id === migration.to_game_server_node_id
    ) {
      this.logger.warn(
        `[${migration.server_id}] finishing a move that was interrupted after switching nodes`,
      );
      await this.complete(migration, [
        "The move was interrupted after the server switched nodes",
        ...(await this.afterCommit(migration)),
      ]);
      return;
    }

    this.logger.warn(
      `[${migration.server_id}] rolling back a move that was interrupted`,
    );

    await this.rollback(
      migration,
      "Failed",
      "The move was interrupted before it finished",
    );
  }

  private async complete(
    migration: ServerMigration,
    warnings: Array<string>,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE server_migrations
          SET status = 'Completed', finished_at = now(), warnings = warnings || $2::jsonb
        WHERE id = $1 AND status = ANY($3::text[])`,
      [
        migration.id,
        JSON.stringify(warnings),
        DedicatedServersService.ACTIVE_MIGRATION_STATUSES,
      ],
    );

    this.logger.log(
      `[${migration.server_id}] moved to ${migration.to_game_server_node_id}`,
    );
  }

  private async heartbeat(
    migration: ServerMigration,
    lockKey: string,
    token: string,
    abort: AbortController,
  ): Promise<void> {
    try {
      const holder = await this.cache.getRaw(lockKey);
      const held =
        holder === token ||
        (holder === null &&
          (await this.cache.acquireLock(
            lockKey,
            DedicatedServerMigrationService.LOCK_TTL_SECONDS,
            token,
          )));

      if (!held) {
        abort.abort(new Error("The move was taken over by another worker"));
        return;
      }

      await this.cache.refreshLock(
        lockKey,
        DedicatedServerMigrationService.LOCK_TTL_SECONDS,
      );
      await this.postgres.query(
        `UPDATE server_migrations SET updated_at = now()
          WHERE id = $1 AND status = ANY($2::text[])`,
        [migration.id, DedicatedServersService.ACTIVE_MIGRATION_STATUSES],
      );
      // Keeps the offline and RCON alerts quiet for a server that is down on
      // purpose.
      await this.dedicatedServers.expectRestart(migration.server_id);
    } catch (error) {
      this.logger.warn(
        `[${migration.server_id}] move heartbeat failed: ${DedicatedServerMigrationService.errorMessage(error)}`,
      );
    }
  }

  private async hasPendingDemoUpload(serverId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<unknown>>(
      `SELECT 1
         FROM matches m
         JOIN match_maps mm ON mm.match_id = m.id
        WHERE m.server_id = $1
          AND m.ended_at >= now() - interval '10 minutes'
          AND mm.status IN ('UploadingDemo', 'WaitingForTV')
        LIMIT 1`,
      [serverId],
    );

    return rows.length > 0;
  }

  private async transition(
    migrationId: string,
    from: string,
    to: string,
  ): Promise<boolean> {
    const rows = await this.postgres.query<Array<unknown>>(
      `UPDATE server_migrations
          SET status = $3, started_at = COALESCE(started_at, now())
        WHERE id = $1 AND status = $2
        RETURNING id`,
      [migrationId, from, to],
    );

    return rows.length > 0;
  }

  private async getMigration(
    migrationId: string,
  ): Promise<(ServerMigration & { stale: boolean }) | undefined> {
    const [migration] = await this.postgres.query<
      Array<ServerMigration & { stale: boolean }>
    >(
      `SELECT id, server_id, from_game_server_node_id, to_game_server_node_id, status, with_files,
              updated_at < now() - interval '2 minutes' AS stale
         FROM server_migrations WHERE id = $1`,
      [migrationId],
    );

    return migration;
  }

  private async getServer(
    serverId: string,
  ): Promise<ServerMigrationServer | undefined> {
    const [server] = await this.postgres.query<Array<ServerMigrationServer>>(
      `SELECT id, game, enabled, is_dedicated, region, reserved_by_match_id, game_server_node_id
         FROM servers WHERE id = $1`,
      [serverId],
    );

    return server;
  }

  private async getNodes(
    nodeIds: Array<string>,
  ): Promise<Map<string, ServerMigrationNode>> {
    const nodes = await this.postgres.query<Array<ServerMigrationNode>>(
      `SELECT n.id, n.label, n.enabled, n.status, host(n.node_ip) AS node_ip, n.update_status,
              n.build_id, n.csgo_build_id, n.disk_available_gb,
              available_dedicated_slot_count(n) AS available_dedicated_slot_count
         FROM game_server_nodes n
        WHERE n.id = ANY($1::text[])`,
      [nodeIds.filter(Boolean)],
    );

    return new Map(nodes.map((node) => [node.id, node]));
  }

  private static throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason ?? new Error("The move was aborted");
    }
  }

  private static errorMessage(error: unknown, signal?: AbortSignal): string {
    const reason = signal?.aborted ? signal.reason : undefined;

    return (
      (reason instanceof Error ? reason.message : undefined) ||
      (error instanceof Error ? error.message : String(error))
    );
  }
}
