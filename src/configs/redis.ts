import { RedisConfig } from "./types/RedisConfig";

export default (): {
  redis: RedisConfig;
} => ({
  redis: {
    connections: {
      default: {
        db: 1,
        host: process.env.APP_REDIS_HOST || "redis",
        port: process.env.APP_REDIS_PORT
          ? parseInt(process.env.APP_REDIS_PORT)
          : undefined,
        password: process.env.APP_REDIS_PASSWORD,
      },
      sub: {
        db: 1,
        host: process.env.APP_REDIS_HOST || "redis",
        port: process.env.APP_REDIS_PORT
          ? parseInt(process.env.APP_REDIS_PORT)
          : undefined,
        password: process.env.APP_REDIS_PASSWORD,
      },
    },
  },
});
