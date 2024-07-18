import { CacheService } from "./cache.service";
import { CachedValue } from "./types/CachedValue";

export class CacheTag {
  private cacheStore: CacheService;
  private tag: string;
  private forgetTag: string;

  constructor(cacheStore: CacheService, tags: string[]) {
    this.cacheStore = cacheStore;
    this.tag = tags.join(":");
    this.forgetTag = `forget:${this.tag}`;
  }
  async get(key?: string): Promise<CachedValue> {
    return await this.waitForLock(async () => {
      const values = await this.cacheStore.get(this.tag);
      if (key) {
        return values ? values?.[key] : undefined;
      }
      return values;
    });
  }
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }
  async put(key: string, value: CachedValue, seconds?: number) {
    return await this.waitForLock(async () => {
      const values = (await this.cacheStore.get(this.tag)) || {};
      values[key] = value;
      try {
        if (seconds) {
          await this.cacheStore.put(this.forgetTag, seconds);
        }
        await this.cacheStore.put(this.tag, values, seconds);
      } catch (error) {
        this.cacheStore.logger.error("unable to put value into redis", error);
        return false;
      }
      return true;
    });
  }
  async forget(key?: string) {
    return await this.waitForLock(async () => {
      if (key) {
        const values = (await this.cacheStore.get(this.tag)) || {};
        delete values[key];
        await this.cacheStore.put(
          this.tag,
          values,
          await this.cacheStore.get(this.forgetTag),
        );
        return;
      }
      await this.cacheStore.forget(this.tag);
      return true;
    });
  }
  async waitForLock(
    callback: () => Promise<CachedValue>,
  ): Promise<CachedValue> {
    return await this.cacheStore.lock(this.tag, callback, 60);
  }
}
