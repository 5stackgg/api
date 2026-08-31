import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import IORedis, { Redis, RedisOptions } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { RedisConfig } from "../../configs/types/RedisConfig";

@Injectable()
export class RedisManagerService implements OnApplicationShutdown {
  private config: RedisConfig;

  protected connections: {
    [key: string]: Redis;
  } = {};

  private healthCheckIntervals: {
    [key: string]: NodeJS.Timeout;
  } = {};

  constructor(
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {
    this.config = this.configService.get("redis");
  }

  onApplicationShutdown() {
    for (const [, interval] of Object.entries(this.healthCheckIntervals)) {
      clearInterval(interval);
    }
    for (const [, conn] of Object.entries(this.connections)) {
      conn.disconnect();
    }
  }

  public getConnection(connection = "default"): Redis {
    if (!this.connections[connection]) {
      const currentConnection: Redis = (this.connections[connection] =
        new IORedis(this.getConfig(connection)));

      currentConnection.on("error", (error) => {
        if (
          !error.message.includes("ECONNRESET") &&
          !error.message.includes("EPIPE") &&
          !error.message.includes("ETIMEDOUT")
        ) {
          this.logger.error("redis error", error);
        }
      });

      /**
       * We may get disconnected, and we may need to force a re-connect.
       */
      const pingTimeoutError = `did not receive ping in time (5 seconds)`;

      currentConnection.on("online", () => {
        if (this.healthCheckIntervals[connection]) {
          clearInterval(this.healthCheckIntervals[connection]);
        }

        this.healthCheckIntervals[connection] = setInterval(async () => {
          if (currentConnection.status === "ready") {
            await new Promise(async (resolve, reject) => {
              const timer = setTimeout(() => {
                this.logger.warn(pingTimeoutError);
                reject(new Error(pingTimeoutError));
              }, 5000);

              await currentConnection.ping(() => {
                clearTimeout(timer);
                resolve(true);
              });
            }).catch((error) => {
              if (error.message !== pingTimeoutError) {
                this.logger.error("error", error);
              }
              currentConnection.disconnect(true);
            });
          }
        }, 5000);
      });
    }
    return this.connections[connection];
  }

  // Every bearer credential the platform hands out -- a practice session invite
  // code, a tournament invite link -- is guessable in principle, and the action
  // that redeems one takes an arbitrary id, so any logged-in caller can grind
  // against every target. Keyed per caller, and the minute is part of the key
  // rather than a refreshed TTL: re-setting the TTL on every attempt would push
  // the window ahead of a caller who never stops and lock them out for good.
  public static async assertRateLimit(
    redis: Redis,
    options: {
      key: string;
      steamId: string;
      limit: number;
      message: string;
    },
  ): Promise<void> {
    const key = `${options.key}:${options.steamId}:${Math.floor(
      Date.now() / 60000,
    )}`;

    // INCR rather than get-then-put: attempts fired concurrently all read the
    // same pre-increment value, and a limit that only counts the ones that
    // happened to be serialised is not a limit. EXPIRE has to follow INCR --
    // on a key that does not exist yet it does nothing, which would leave the
    // counter with no TTL at all.
    const result = await redis.multi().incr(key).expire(key, 120).exec();

    // An aborted MULTI answers null and a failed command answers [error, null],
    // so the INCR reply is only trustworthy when it is an actual number -- and
    // a counter that reads 0 whenever Redis breaks is a limiter that switches
    // itself off exactly when someone is hammering it. Refuse instead: the
    // credentials this guards are guessable, and a caller who cannot be counted
    // cannot be let through.
    const [error, count] = result?.[0] ?? [];

    if (error || typeof count !== "number" || count > options.limit) {
      throw Error(options.message);
    }
  }

  public getConfig(connection: string): RedisOptions {
    if (!this.config.connections[connection]) {
      throw new Error(`Redis connection ${connection} not found`);
    }

    return Object.assign(
      {},
      {
        enableReadyCheck: false,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        showFriendlyErrorStack: !!process.env.DEV,
        // our startup probe fails after 60 seconds
        retryAttempts: 22,
        retryStrategy() {
          return 5 * 1000;
        },
      },
      this.config.connections[connection],
    );
  }
}
