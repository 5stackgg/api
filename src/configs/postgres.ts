import { PostgresConfig } from "./types/PostgresConfig";

export default (): {
  postgres: PostgresConfig;
} => ({
  postgres: {
    connections: {
      default: {
        user: process.env.POSTGRES_USER || "hasura",
        password: process.env.POSTGRES_PASSWORD || "hasura",
        host: process.env.POSTGRES_HOST || "timescaledb",
        port: process.env.POSTGRES_SERVICE_PORT
          ? parseInt(process.env.POSTGRES_SERVICE_PORT)
          : undefined,
        database: process.env.POSTGRES_DB || "hasura",
        statement_timeout: 1000 * 60,
        max: parseInt(process.env.DB_MAX_POOLS || "5"),
      },
    },
  },
});
