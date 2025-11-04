import { Pool } from "pg";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresConfig } from "../configs/types/PostgresConfig";
import Cursor from "pg-cursor";

@Injectable()
export class PostgresService {
  private pool: Pool;
  private config: PostgresConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: Logger,
  ) {
    this.config = this.configService.get("postgres");
    this.pool = new Pool(this.config.connections.default);
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

  public async *cursor<T>(
    sql: string,
    values?: Array<any>,
    batchSize: number = 100,
  ): AsyncGenerator<T[]> {
    const client = await this.pool.connect();
    const cursor = new Cursor(sql, values);

    client.query(cursor as any);

    try {
      while (true) {
        const rows = await cursor.read(batchSize);

        if (rows.length === 0) {
          break;
        }

        yield rows as T[];
      }
    } finally {
      try {
        await cursor.close();
      } catch (error) {
        this.logger.warn("unable to close cursor", error);
      }

      try {
        client.release();
      } catch (error) {
        this.logger.warn("unable to release client", error);
      }
    }
  }
}
