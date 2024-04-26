import { PoolConfig } from "pg";

export type PostgresConfig = {
  connections: Record<string, PoolConfig>;
};
