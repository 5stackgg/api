import { Injectable, Logger } from "@nestjs/common";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import Redis from "ioredis";
import { CacheService } from "../../cache/cache.service";
import { e_match_status_enum } from "../../../generated/zeus";
import { HasuraService } from "../../hasura/hasura.service";

type Match = {
  id: string;
  server?: {
    id: string;
    api_password: string;
  };
};

@Injectable()
export class ServerAuthService {
  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    readonly redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();

    this.redis.on("online", async (online) => {
      if (online) {
      }
    });
  }

  public async setup() {
    const matches = await this.getMatches();

    for (const match of matches) {
      void this.addMatch(match).catch((error) => {
        this.logger.warn(
          `unable to setup redis ACL for match ${match.id}`,
          error,
        );
      });
    }
  }

  private async getMatches() {
    const { matches } = await this.hasura.query({
      matches: [
        {
          where: {
            server_id: {
              _is_null: false,
            },
            status: {
              _eq: e_match_status_enum.Live,
            },
          },
        },
        {
          id: true,
          server: {
            id: true,
            api_password: true,
          },
        },
      ],
    });

    return matches as Array<
      Omit<(typeof matches)[number], "server"> & {
        server: Required<NonNullable<(typeof matches)[number]["server"]>>;
      }
    >;
  }

  public async addMatchById(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          id: true,
          server: {
            id: true,
            api_password: true,
          },
        },
      ],
    });

    await this.addMatch(match);
  }

  public async addMatch(match: Match) {
    const acl = [
      "on",
      `>${match.server.api_password}`,
      `+auth`,
      `+command`,
      `+echo`,
      `+ping`,
      "+publish",
      `&matches:${match.id}`,
    ];

    const cacheKey = this.getGameServerRedisHash(match.server.id);
    const expectedHash = new Buffer(acl.join("")).toString("base64");
    const hash = await this.cache.get(cacheKey);

    if (expectedHash === hash) {
      return;
    }

    // ACL's are additive
    await this.removeServer(match.server.id);

    await this.redis.acl("SETUSER", match.server.id, ...acl);
    await this.cache.put(cacheKey, expectedHash);
  }

  public async removeServer(serverId: string) {
    const cacheKey = this.getGameServerRedisHash(serverId);
    await this.cache.forget(cacheKey);
    await this.redis.acl("DELUSER", serverId);
  }

  private getGameServerRedisHash(serverId: string) {
    // gsrh: game server redis hash
    return `gsrh:${serverId}`;
  }
}
