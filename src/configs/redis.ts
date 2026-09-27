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
      // Playcast relay traffic: its own socket so fragment payloads never queue
      // behind session lookups, and failing fast so an outage answers viewers
      // and game servers with a 503 instead of holding their requests open.
      relay: {
        db: 1,
        host: process.env.REDIS_HOST || "redis",
        port: process.env.REDIS_SERVICE_PORT
          ? parseInt(process.env.REDIS_SERVICE_PORT)
          : undefined,
        password: process.env.REDIS_PASSWORD,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 2000,
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
