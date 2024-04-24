import { Injectable } from "@nestjs/common";
import { Rcon as RconClient } from "rcon-client";
import { HasuraService } from "../hasura/hasura.service";

@Injectable()
export class RconService {
  constructor(private readonly hasuraService: HasuraService) {}

  private CONNECTION_TIMEOUT = 10 * 1000;

  private connections: Record<string, RconClient> = {};
  private connectTimeouts: Record<string, NodeJS.Timeout> = {};

  public async connect(serverId: string) {
    if (this.connections[serverId]) {
      this.setupConnectionTimeout(serverId);

      return this.connections[serverId];
    }

    const { servers_by_pk: server } = await this.hasuraService.query({
      servers_by_pk: [
        {
          id: serverId,
        },
        {
          host: true,
          port: true,
          rcon_password: true,
        },
      ],
    });

    if (!server) {
      throw Error(`unable to find server ${serverId}`);
    }

    const rcon = new RconClient({
      host: server.host,
      port: server.port,
      password: server.rcon_password,
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

    await rcon.connect();

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
      await this.connections[serverId].end();
    }
    return;
  }
}
