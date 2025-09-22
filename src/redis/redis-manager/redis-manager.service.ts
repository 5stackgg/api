import { Injectable, Logger } from "@nestjs/common";
import IORedis, { Redis, RedisOptions } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { RedisConfig } from "../../configs/types/RedisConfig";

@Injectable()
export class RedisManagerService {
  private config: RedisConfig;

  protected connections: {
    [key: string]: Redis;
  } = {};

  constructor(
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {
    this.config = this.configService.get("redis");
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
      let setupPingPong = false;
      currentConnection.on("online", () => {
        if (setupPingPong) {
          return;
        }
        setupPingPong = true;

        const pingTimeoutError = `did not receive ping in time (5 seconds)`;

        setInterval(async () => {
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

  public getConfig(connection: string): RedisOptions {
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
