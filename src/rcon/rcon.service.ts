import { Injectable, Logger } from "@nestjs/common";
import { Rcon as RconClient } from "rcon-client";
import { HasuraService } from "../hasura/hasura.service";
import { EncryptionService } from "../encryption/encryption.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class RconService {
  constructor(
    private readonly hasuraService: HasuraService,
    private readonly encryption: EncryptionService,
    private readonly notifications: NotificationsService,
    private readonly logger: Logger,
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
}
