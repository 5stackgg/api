import { RedisConfig } from "./types/RedisConfig";

export default (): {
  redis: RedisConfig;
} => ({
  redis: {
    connections: {
      default: {
        db: 1,
        host: process.env.APP_REDIS_HOST || "redis",
        port: (process.env.APP_REDIS_PORT as unknown) as number,
        password: process.env.APP_REDIS_PASSWORD,
      },
    },
  },
});
