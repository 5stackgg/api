import { Injectable, Logger } from "@nestjs/common";
import { Rcon as RconClient } from "rcon-client";
import { HasuraService } from "../hasura/hasura.service";
import { EncryptionService } from "../encryption/encryption.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TypeSenseService } from "../type-sense/type-sense.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";

@Injectable()
export class RconService {
  constructor(
    private readonly hasuraService: HasuraService,
    private readonly encryption: EncryptionService,
    private readonly notifications: NotificationsService,
    private readonly logger: Logger,
    private readonly cache: RedisManagerService,
    private readonly typeSenseService: TypeSenseService,
    private readonly redisManager: RedisManagerService,
  ) {}

  private CONNECTION_TIMEOUT = 3 * 1000;

  private connections: Record<string, RconClient> = {};
  private connectTimeouts: Record<string, NodeJS.Timeout> = {};

  public async connect(serverId: string): Promise<RconClient | null> {
    if (this.connections[serverId]) {
      this.setupConnectionTimeout(serverId);

      return this.connections[serverId];
    }

    const { servers_by_pk: server } = await this.hasuraService.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        host: true,
        port: true,
        label: true,
        region: true,
        is_dedicated: true,
        rcon_status: true,
        rcon_password: true,
        game_server_node: {
          node_ip: true,
          version: {
            cvars: true,
            current: true,
          },
        },
      },
    });

    if (!server) {
      throw Error(`unable to find server ${serverId}`);
    }

    const rcon = new RconClient({
      timeout: this.CONNECTION_TIMEOUT,
      host: server.game_server_node?.node_ip
        ? server.game_server_node.node_ip
        : server.host,
      port: server.port,
      password: await this.encryption.decrypt(
        server.rcon_password as unknown as string,
      ),
    });

    rcon.send = async (command) => {
      const payload = (
        await rcon.sendRaw(Buffer.from(command, "utf-8"))
      ).toString();

      return payload;
    };

    rcon
      .on("error", async () => {
        await this.disconnect(serverId);
      })
      .on("end", () => {
        if (!this.connections[serverId]) {
          return;
        }
        delete this.connections[serverId];
      });

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `RCON connection timeout after ${this.CONNECTION_TIMEOUT}ms`,
            ),
          );
        }, this.CONNECTION_TIMEOUT);
      });

      await Promise.race([rcon.connect(), timeoutPromise]);

      if (!server.rcon_status && server.is_dedicated) {
        this.hasuraService.mutation({
          update_servers_by_pk: {
            __args: {
              pk_columns: {
                id: serverId,
              },
              _set: {
                rcon_status: true,
              },
            },
            id: true,
          },
        });
      }

      const version = server.game_server_node?.version;
      if (version?.current === true && version?.cvars === false) {
        await this.genreateCvars(serverId);
      }
    } catch (error) {
      try {
        if (rcon.authenticated) {
          rcon.end();
        }
      } catch (cleanupError) {
        this.logger.warn("Error during RCON cleanup:", cleanupError);
      }

      if (server.rcon_status && server.is_dedicated) {
        this.hasuraService.mutation({
          update_servers_by_pk: {
            __args: {
              pk_columns: {
                id: serverId,
              },
              _set: {
                rcon_status: false,
              },
            },
            id: true,
          },
        });

        this.notifications.send("DedicatedServerRconStatus", {
          message: `Dedicated Server (${server.label || serverId}) is not able to connect to the RCON.`,
          title: "Dedicated Server RCON Error",
          role: "system_administrator",
          entity_id: serverId,
        });
      }
      return;
    }

    this.setupConnectionTimeout(serverId);

    return (this.connections[serverId] = rcon);
  }

  private setupConnectionTimeout(serverId: string) {
    clearTimeout(this.connectTimeouts[serverId]);
    this.connectTimeouts[serverId] = setTimeout(async () => {
      await this.disconnect(serverId);
    }, this.CONNECTION_TIMEOUT);
  }

  public async disconnect(serverId: string) {
    clearTimeout(this.connectTimeouts[serverId]);

    if (this.connections[serverId]) {
      this.connections[serverId].end();
      delete this.connections[serverId];
    }
  }

  public async genreateCvars(serverId: string) {
    const { servers_by_pk: server } = await this.hasuraService.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        game_server_node: {
          version: {
            build_id: true,
            cvars: true,
            current: true,
          },
        },
      },
    });

    if (
      server.game_server_node?.version?.current === false ||
      server.game_server_node?.version?.cvars === true
    ) {
      return;
    }

    await this.typeSenseService.resetCvars();

    const buildId = server.game_server_node?.version?.build_id.toString();

    if (!buildId) {
      throw Error(`unable to find build id for server ${serverId}`);
    }

    this.logger.log(`generating cvars for build: ${buildId}`);

    const hasLock = await this.aquireCvarsLock(buildId);
    if (!hasLock) {
      this.logger.warn(`unable to aquire cvars lock for build: ${buildId}`);
      return;
    }

    let totalCvars = 0;
    try {
      const rcon = await this.connect(serverId);
      if (!rcon) {
        throw Error(`unable to connect to server ${serverId}`);
      }

      const prefixes = [
        "+",
        "-",
        "_",
        ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
      ];

      for (const prefix of prefixes) {
        const parsedCvars = this.parseCvarList(
          await rcon.send(`Cvarlist ${prefix}`),
        );
        await this.typeSenseService.upsertCvars(parsedCvars);
        totalCvars = totalCvars + parsedCvars.length;
      }

      await this.hasuraService.mutation({
        update_game_versions_by_pk: {
          __args: {
            pk_columns: { build_id: Number(buildId) },
            _set: { cvars: true },
          },
          cvars: true,
        },
      });
    } catch (error) {
      this.logger.error(
        `unable to generate cvars for build: ${buildId}`,
        error,
      );
      throw error;
    } finally {
      await this.releaseCvarsLock(buildId);
    }
    this.logger.log(`generated ${totalCvars} cvars for build: ${buildId}`);
  }

  private parseCvarList(
    output: string,
  ): Array<{ name: string; kind: string; flags: string; description: string }> {
    const lines = output.split(/\r?\n/);
    const entries: Array<{
      name: string;
      kind: string;
      flags: string;
      description: string;
    }> = [];

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line) {
        continue;
      }

      const lower = line.toLowerCase();

      if (
        lower === "cvar list" ||
        line.startsWith("---") ||
        lower.includes("convars/concommands for")
      ) {
        continue;
      }

      // Ignore noisy status lines that sometimes precede results
      if (/(watching for changes|^list\s*:)/i.test(line)) {
        continue;
      }

      // Match 4 columns split by ':' allowing optional spaces and empty description
      const match = line.match(
        /^\s*([^:]+)\s*:\s*([^:]+)\s*:\s*([^:]*)\s*:\s*(.*)$/,
      );
      if (!match) {
        this.logger.warn(`unable to parse cvar list: ${line}`);
        continue;
      }

      const name = match[1]?.trim();
      const kind = match[2]?.trim();
      const flags = match[3]?.trim();
      const description = (match[4] ?? "").trim();

      if (!name) {
        this.logger.warn(`unable to parse cvar list: ${line}`);
        continue;
      }

      entries.push({ name, kind, flags, description });
    }
    return entries;
  }

  private async aquireCvarsLock(buildId: string): Promise<boolean> {
    const lockKey = `cvars:lock:${buildId}`;
    const result = await this.redisManager
      .getConnection()
      .set(lockKey, 1, "EX", 60, "NX");
    if (result === null) {
      return false;
    }
    return true;
  }

  private async releaseCvarsLock(buildId: string) {
    const lockKey = `cvars:lock:${buildId}`;
    await this.redisManager.getConnection().del(lockKey);
  }
}
