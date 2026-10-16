import Redis from "ioredis";
import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { CacheTag } from "./CacheTag";
import { CachedValue } from "./types/CachedValue";

@Injectable()
export class CacheService {
  private connection: Redis;

  constructor(
    redis: RedisManagerService,
    public readonly logger: Logger,
  ) {
    this.connection = redis.getConnection();
  }

  public async get(key: string, defaultValue?: any) {
    const value = await this.connection.get(key);

    if (value !== null && value !== undefined) {
      return JSON.parse(value);
    }
    return defaultValue;
  }

  public async has(key: string) {
    return (await this.get(key)) !== undefined;
  }

  public async put(key: string, value: CachedValue, seconds?: number) {
    try {
      const serialized = JSON.stringify(value);

      if (seconds) {
        await this.connection.set(key, serialized, "EX", seconds);
      } else {
        await this.connection.set(key, serialized);
      }

      return true;
    } catch (error) {
      this.logger.error("unable to put value into redis", error);
      return false;
    }
  }

  // For values that are already JSON. Putting a document that is tens of
  // megabytes through JSON.stringify only escapes it into a second copy of
  // itself, and the caller that inflated it is holding the string anyway.
  public async putRaw(key: string, value: string, seconds?: number) {
    try {
      if (seconds) {
        await this.connection.set(key, value, "EX", seconds);
      } else {
        await this.connection.set(key, value);
      }

      return true;
    } catch (error) {
      this.logger.error("unable to put value into redis", error);
      return false;
    }
  }

  public async getRaw(key: string): Promise<string | null> {
    return await this.connection.get(key);
  }

  public async forget(...keys: Array<string>) {
    if (keys.length === 0) {
      return true;
    }

    try {
      await this.connection.del(...keys);
      return true;
    } catch (error) {
      this.logger.error("unable to remove value from redis", error);
      return false;
    }
  }

  // A lock can run out while its holder is still working and be taken by
  // someone else, so it is only refreshed or released by the token it was
  // taken with.
  private static readonly RELEASE_LOCK_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;

  private static readonly REFRESH_LOCK_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('EXPIRE', KEYS[1], ARGV[2])
    end
    return 0
  `;

  // A refused request hands its amount back, so being over the limit never
  // pushes the window's count further out of reach.
  private static readonly CONSUME_SCRIPT = `
    local count = redis.call('INCRBY', KEYS[1], ARGV[1])
    if count == tonumber(ARGV[1]) then
      redis.call('PEXPIRE', KEYS[1], ARGV[3])
    end
    if count > tonumber(ARGV[2]) then
      redis.call('DECRBY', KEYS[1], ARGV[1])
      return 0
    end
    return 1
  `;

  public async consume(
    key: string,
    amount: number,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    return (
      (await this.connection.eval(
        CacheService.CONSUME_SCRIPT,
        1,
        key,
        amount,
        limit,
        windowMs,
      )) === 1
    );
  }

  public async acquireLock(
    key: string,
    seconds: number,
    token: string = randomUUID(),
  ): Promise<string | null> {
    try {
      const result = await this.connection.set(key, token, "EX", seconds, "NX");
      return result === "OK" ? token : null;
    } catch (error) {
      this.logger.error("unable to acquire lock in redis", error);
      return null;
    }
  }

  public async refreshLock(
    key: string,
    token: string,
    seconds: number,
  ): Promise<boolean> {
    try {
      return (
        (await this.connection.eval(
          CacheService.REFRESH_LOCK_SCRIPT,
          1,
          key,
          token,
          seconds,
        )) === 1
      );
    } catch (error) {
      this.logger.error("unable to refresh lock in redis", error);
      return false;
    }
  }

  public async releaseLock(key: string, token: string): Promise<boolean> {
    try {
      return (
        (await this.connection.eval(
          CacheService.RELEASE_LOCK_SCRIPT,
          1,
          key,
          token,
        )) === 1
      );
    } catch (error) {
      this.logger.error("unable to release lock in redis", error);
      return false;
    }
  }

  public async remember<T>(
    key: string,
    callback: () => T | Promise<T>,
    seconds: number,
  ): Promise<T | undefined> {
    const value = (await this.get(key)) as T | undefined;
    if (value !== undefined) {
      return value;
    }

    const result = await callback();
    if (result !== undefined) {
      await this.put(key, result, seconds);
      return result;
    }
  }

  public async rememberForever<T>(
    key: string,
    callback: () => T | Promise<T>,
  ): Promise<T | undefined> {
    const value = (await this.get(key)) as T | undefined;
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
    expires = 60,
    maxAttempts = 10,
  ): Promise<CachedValue> {
    const lockKey = `lock:${key}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const token = randomUUID();
      if (await this.connection.set(lockKey, token, "EX", expires, "NX")) {
        try {
          return await callback();
        } finally {
          await this.releaseLock(lockKey, token);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Failed to acquire lock for ${key} after ${maxAttempts} attempts`,
    );
  }

  public tags(tags: Array<string>) {
    return new CacheTag(this, tags);
  }
}
