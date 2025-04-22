import { Injectable } from "@nestjs/common";
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
  ) {}

  private CONNECTION_TIMEOUT = 10 * 1000;

  private connections: Record<string, RconClient> = {};
  private connectTimeouts: Record<string, NodeJS.Timeout> = {};

  public async connect(serverId: string) {
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
        region: true,
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
        delete this.connections[serverId];
      });

    try {
      await rcon.connect();
      if (server.rcon_status) {
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
        message: `Dedicated Server ${serverId} is not able to connect to the RCON.`,
        title: "Dedicated Server RCON Error",
        role: "administrator",
        entity_id: serverId,
      });

      // TODO - we should return null here
      return rcon;
    }

    this.setupConnectionTimeout(serverId);

    return (this.connections[serverId] = rcon);
  }

  public async testConnection(serverId: string) {
    await this.connect(serverId);

    await this.disconnect(serverId);
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
      await this.connections[serverId].end();
    }
    return;
  }
}
