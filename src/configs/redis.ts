import { RedisConfig } from "./types/RedisConfig";

export default (): {
  redis: RedisConfig;
} => ({
  redis: {
    connections: {
      default: {
        db: 1,
        host: process.env.REDIS_HOST || "redis",
        port: process.env.REDIS_SERVICE_PORT
          ? parseInt(process.env.REDIS_SERVICE_PORT)
          : undefined,
        password: process.env.REDIS_PASSWORD,
      },
      sub: {
        db: 1,
        host: process.env.REDIS_HOST || "redis",
        port: process.env.REDIS_SERVICE_PORT
          ? parseInt(process.env.REDIS_SERVICE_PORT)
          : undefined,
        password: process.env.REDIS_PASSWORD,
      },
    },
  },
});
