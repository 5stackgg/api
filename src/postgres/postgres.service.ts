import { Client, Pool } from "pg";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresConfig } from "../configs/types/PostgresConfig";

@Injectable()
export class PostgresService {
  private pool: Pool;
  private config: PostgresConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.get("postgres");
    this.pool = new Pool(this.config.connections.default);
  }

  public async connect() {
    try {
      const client = await this.getClient();
      await client.connect();
      await client.end();
    } catch (error) {
      throw error;
    }
    return true;
  }

  private async getClient(connection = "default") {
    return new Client(this.config.connections[connection]);
  }

  public getPoolStats() {
    const { totalCount, idleCount, waitingCount } = this.pool;
    return { totalCount, idleCount, waitingCount };
  }

  public async query<T>(
    sql: string,
    bindings?: Array<
      | string
      | number
      | Date
      | bigint
      | Buffer
      | Array<string>
      | Array<number>
      | Array<Date>
      | Array<bigint>
    >,
  ): Promise<T> {
    const result = await this.pool.query(sql, bindings);

    if (result.rows) {
      return result.rows as unknown as T;
    }

    return result as unknown as T;
  }
}
