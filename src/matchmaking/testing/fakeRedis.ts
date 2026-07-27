/**
 * In-memory stand-in for the subset of redis the matchmaking service uses.
 *
 * Matchmaking's correctness is mostly about queue state - a lobby must never be
 * in two matches, and must never fall out of the queue without being matched.
 * Asserting that against `jest.fn()` mocks only proves which calls were made,
 * not what the queue ended up looking like, so the tests drive this instead.
 */
export class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();

  // lock ttls are load bearing in matchmaking - a lobby lock that never expires
  // means that lobby can never be matched again - so expiry is modelled against
  // a virtual clock the tests advance explicitly
  private expiries = new Map<string, number>();
  private clock = 0;

  public published: Array<{ channel: string; message: string }> = [];

  advanceTime(milliseconds: number) {
    this.clock += milliseconds;
  }

  private expireIfDue(key: string) {
    const deadline = this.expiries.get(key);
    if (deadline !== undefined && deadline <= this.clock) {
      this.expiries.delete(key);
      this.strings.delete(key);
      this.hashes.delete(key);
      this.sortedSets.delete(key);
      return true;
    }
    return false;
  }

  private zset(key: string) {
    let set = this.sortedSets.get(key);
    if (!set) {
      set = new Map();
      this.sortedSets.set(key, set);
    }
    return set;
  }

  private hash(key: string) {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  async set(key: string, value: unknown, ...args: unknown[]) {
    this.expireIfDue(key);

    const nx = args.some(
      (arg) => typeof arg === "string" && arg.toUpperCase() === "NX",
    );

    if (nx && this.strings.has(key)) {
      return null;
    }

    const exIndex = args.findIndex(
      (arg) => typeof arg === "string" && arg.toUpperCase() === "EX",
    );

    this.strings.set(key, String(value));

    if (exIndex !== -1) {
      this.expiries.set(key, this.clock + Number(args[exIndex + 1]) * 1000);
    }

    return "OK";
  }

  async get(key: string) {
    this.expireIfDue(key);
    return this.strings.get(key) ?? null;
  }

  async del(key: string) {
    this.expiries.delete(key);
    const existed =
      this.strings.delete(key) ||
      this.hashes.delete(key) ||
      this.sortedSets.delete(key);
    return existed ? 1 : 0;
  }

  async expire(key: string, seconds: number) {
    this.expireIfDue(key);

    if (seconds === 0) {
      return (await this.del(key)) as number;
    }

    if (!this.strings.has(key) && !this.hashes.has(key)) {
      return 0;
    }

    this.expiries.set(key, this.clock + seconds * 1000);
    return 1;
  }

  private zadds = 0;

  async zadd(key: string, score: number, member: string) {
    this.zadds++;
    const set = this.zset(key);
    const isNew = !set.has(member);
    set.set(member, score);
    return isNew ? 1 : 0;
  }

  /** Total zadds issued, for asserting the queue is not churned needlessly. */
  zaddCount() {
    return this.zadds;
  }

  async zrem(key: string, member: string) {
    return this.zset(key).delete(member) ? 1 : 0;
  }

  async zcard(key: string) {
    return this.zset(key).size;
  }

  async zrange(key: string, start: number, stop: number, withScores?: string) {
    const entries = [...this.zset(key).entries()].sort((a, b) =>
      a[1] !== b[1] ? a[1] - b[1] : a[0].localeCompare(b[0]),
    );

    const end = stop === -1 ? entries.length : stop + 1;
    const sliced = entries.slice(start, end);

    if (withScores?.toUpperCase() === "WITHSCORES") {
      return sliced.flatMap(([member, score]) => [member, String(score)]);
    }

    return sliced.map(([member]) => member);
  }

  // ioredis accepts both hset(key, field, value) and hset(key, {field: value})
  async hset(key: string, field: string | Record<string, unknown>, value?: unknown) {
    const hash = this.hash(key);

    if (typeof field === "object") {
      for (const [name, entry] of Object.entries(field)) {
        hash.set(name, String(entry));
      }
      return Object.keys(field).length;
    }

    hash.set(field, String(value));
    return 1;
  }

  async hget(key: string, field: string) {
    return this.hash(key).get(field) ?? null;
  }

  async hgetall(key: string) {
    return Object.fromEntries(this.hash(key));
  }

  async hdel(key: string, field: string) {
    return this.hash(key).delete(field) ? 1 : 0;
  }

  async publish(channel: string, message: string) {
    this.published.push({ channel, message });
    return 1;
  }

  /**
   * The redis EVAL command, not javascript eval. The lua source is ignored, not
   * interpreted - this hardcodes the one script matchmaking runs
   * (CLAIM_LOBBY_SCRIPT): SET NX the lock, and on success ZREM the lobby from
   * every queue key passed in. Atomic here by virtue of being synchronous,
   * which is the property the real script buys with lua.
   */
  async eval(_script: string, numKeys: number, ...args: unknown[]) {
    const keys = args.slice(0, numKeys) as string[];
    const [member, ttl] = args.slice(numKeys) as [string, number];

    const acquired = await this.set(keys[0], 1, "EX", ttl, "NX");
    if (!acquired) {
      return 0;
    }

    for (const key of keys.slice(1)) {
      await this.zrem(key, member);
    }

    return 1;
  }

  // --- test helpers

  members(key: string) {
    return [...this.zset(key).keys()].sort();
  }

  has(key: string) {
    return this.strings.has(key) || this.hashes.has(key);
  }

  keys(prefix: string) {
    return [
      ...this.strings.keys(),
      ...this.hashes.keys(),
      ...this.sortedSets.keys(),
    ].filter((key) => key.startsWith(prefix));
  }
}
