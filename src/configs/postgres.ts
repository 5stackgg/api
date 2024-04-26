import { PostgresConfig } from "./types/PostgresConfig";

export default (): {
  postgres: PostgresConfig;
} => ({
  postgres: {
    connections: {
      default: {
        user: process.env.DB_USER || "hasura",
        password: process.env.DB_PASSWORD || "hasura",
        host: process.env.DB_HOST || "postgres",
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
        database: process.env.DB_DATABASE || "hasura",
        statement_timeout: 1000 * 60,
        max: parseInt(process.env.DB_MAX_POOLS || "5"),
      },
    },
  },
});
