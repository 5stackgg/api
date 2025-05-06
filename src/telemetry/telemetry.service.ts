import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { HasuraService } from "src/hasura/hasura.service";
import Redis from "ioredis";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";

@Injectable()
export class TelemetryService {
  private readonly appConfig: AppConfig;
  private readonly redis: Redis;
  constructor(
    private readonly logger: Logger,
    private readonly redisManagerService: RedisManagerService,
    private readonly hasuraService: HasuraService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.redis = this.redisManagerService.getConnection();
  }

  async send() {
    if (!(await this.isEnabled())) {
      this.logger.log("telemetry is disabled");
      return;
    }

    await fetch("https://5stack.gg/telemetry", {
      method: "POST",
    });
  }

  async record(ip: string, data: Record<string, any>) {
    await this.redis.setex(
      `online_system:${ip}`,
      60 * 60,
      JSON.stringify(data),
    );
  }

  async getOnlineSystemsCount(): Promise<number> {
    const keys = await this.redis.keys("online_system:*");
    return keys.length;
  }

  private async isEnabled() {
    if (this.appConfig.webDomain.includes("://5stack.gg")) {
      return false;
    }

    const { settings_by_pk: telemetry } = await this.hasuraService.query({
      settings_by_pk: {
        __args: {
          name: "telemetry",
        },
        value: true,
      },
    });

    return telemetry?.value !== "false";
  }
}
