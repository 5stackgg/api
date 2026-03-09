import { CacheTag } from "./CacheTag";

function createMockCacheStore() {
  const store = new Map<string, any>();
  const cacheStore = {
    get: jest.fn(async (key: string) => store.get(key)),
    put: jest.fn(async (key: string, value: any, _seconds?: number) => {
      store.set(key, value);
      return true;
    }),
    forget: jest.fn(async (key: string) => {
      store.delete(key);
      return true;
    }),
    lock: jest.fn(async (_key: string, cb: () => Promise<any>, _expires?: number) => {
      return await cb();
    }),
    logger: { error: jest.fn() },
    _store: store,
  };
  return cacheStore;
}

describe("CacheTag", () => {
  describe("constructor", () => {
    it("joins tags with colon", () => {
      const cacheStore = createMockCacheStore();
      const tag = new CacheTag(cacheStore as any, ["user", "123"]);
      // Verify the tag key by calling get and checking what key is passed
      tag.get();
      expect(cacheStore.get).toHaveBeenCalledWith("user:123");
    });
  });

  describe("put", () => {
    it("stores value under tag key", async () => {
      const cacheStore = createMockCacheStore();
      const tag = new CacheTag(cacheStore as any, ["items"]);

      await tag.put("a", "value-a");

      // Should get existing values, merge, then put back
      expect(cacheStore.put).toHaveBeenCalledWith(
        "items",
        { a: "value-a" },
        undefined,
      );
    });

    it("merges with existing values", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { existing: "data" });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      await tag.put("new", "val");

      expect(cacheStore.put).toHaveBeenCalledWith(
        "items",
        { existing: "data", new: "val" },
        undefined,
      );
    });

    it("sets forgetTag TTL when seconds provided", async () => {
      const cacheStore = createMockCacheStore();
      const tag = new CacheTag(cacheStore as any, ["items"]);

      await tag.put("a", "val", 120);

      expect(cacheStore.put).toHaveBeenCalledWith("forget:items", 120);
      expect(cacheStore.put).toHaveBeenCalledWith(
        "items",
        { a: "val" },
        120,
      );
    });

    it("returns false on error", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore.put.mockRejectedValueOnce(new Error("fail"));
      const tag = new CacheTag(cacheStore as any, ["items"]);

      const result = await tag.put("a", "val", 60);
      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("returns all values when no key specified", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1, b: 2 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      const result = await tag.get();
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("returns specific key value", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1, b: 2 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      const result = await tag.get("b");
      expect(result).toBe(2);
    });

    it("returns undefined for missing key", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      const result = await tag.get("missing");
      expect(result).toBeUndefined();
    });

    it("returns undefined when tag not in cache", async () => {
      const cacheStore = createMockCacheStore();
      const tag = new CacheTag(cacheStore as any, ["items"]);

      const result = await tag.get("any");
      expect(result).toBeUndefined();
    });
  });

  describe("has", () => {
    it("returns true when key exists", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      expect(await tag.has("a")).toBe(true);
    });

    it("returns false when key missing", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      expect(await tag.has("b")).toBe(false);
    });
  });

  describe("forget", () => {
    it("removes specific key from tag values", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1, b: 2 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      await tag.forget("a");

      // Should re-put without the forgotten key
      expect(cacheStore.put).toHaveBeenCalledWith(
        "items",
        { b: 2 },
        undefined, // forgetTag value (not set in store)
      );
    });

    it("forgets entire tag when no key specified", async () => {
      const cacheStore = createMockCacheStore();
      cacheStore._store.set("items", { a: 1 });
      const tag = new CacheTag(cacheStore as any, ["items"]);

      const result = await tag.forget();
      expect(result).toBe(true);
      expect(cacheStore.forget).toHaveBeenCalledWith("items");
    });
  });

  describe("waitForLock", () => {
    it("delegates to cacheStore.lock with 60s expiry", async () => {
      const cacheStore = createMockCacheStore();
      const tag = new CacheTag(cacheStore as any, ["items"]);
      const cb = jest.fn().mockResolvedValue("locked-result");

      const result = await tag.waitForLock(cb);

      expect(result).toBe("locked-result");
      expect(cacheStore.lock).toHaveBeenCalledWith("items", cb, 60);
    });
  });
});
