import Redis from "ioredis";
import { Injectable, Logger } from "@nestjs/common";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { CacheTag } from "./CacheTag";
import { CachedValue } from "./types/CachedValue";

@Injectable()
export class CacheService {
  private connection: Redis;

  constructor(redis: RedisManagerService, public readonly logger: Logger) {
    this.connection = redis.getConnection();
  }

  public async get(key: string) {
    const value = await this.connection.get(key);

    if (value !== null && value !== undefined) {
      return JSON.parse(value);
    }
  }

  public async has(key: string) {
    return (await this.get(key)) !== undefined;
  }

  public async put(key: string, value: CachedValue, seconds?: number) {
    try {
      await this.connection.set(key, JSON.stringify(value));

      if (seconds) {
        await this.expireIn(key, seconds);
      }

      return true;
    } catch (error) {
      this.logger.error("unable to put value into redis", error);
      return false;
    }
  }

  public async forget(key: string) {
    try {
      await this.connection.del(key);
      return true;
    } catch (error) {
      this.logger.error("unable to remove value from redis", error);
      return false;
    }
  }

  public async remember(
    key: string,
    callback: () => CachedValue,
    seconds: number
  ) {
    const value = await this.get(key);
    if (value !== undefined) {
      return value;
    }

    const result = await callback();
    if (result !== undefined) {
      await this.put(key, result, seconds);
      return result;
    }
  }

  public async rememberForever(key: string, callback: () => CachedValue) {
    const value = await this.get(key);
    if (value !== undefined) {
      return value;
    }

    const result = await callback();
    if (result !== undefined) {
      await this.put(key, result);
      return result;
    }
  }

  public async lock(
    key: string,
    callback: () => Promise<CachedValue>,
    expires = 60
  ): Promise<CachedValue> {
    const lockKey = `lock:${key}`;
    if (await this.connection.set(lockKey, 1, "EX", expires, "NX")) {
      try {
        return await callback();
      } finally {
        await this.forget(lockKey);
      }
    }
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(true);
      }, 100);
    });
    return await this.lock(key, callback);
  }
  private async expireIn(key: string, seconds: number) {
    return this.connection.expire(key, seconds);
  }

  public tags(tags: Array<string>) {
    return new CacheTag(this, tags);
  }
}
