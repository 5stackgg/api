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

  // Redis refuses a command against a key of another type, which is what
  // catches a fixture that stores something the real code never would.
  private assertType(key: string, type: "string" | "hash" | "zset") {
    this.expireIfDue(key);

    const actual = this.strings.has(key)
      ? "string"
      : this.hashes.has(key)
        ? "hash"
        : this.sortedSets.has(key)
          ? "zset"
          : undefined;

    if (actual && actual !== type) {
      throw new Error(
        `WRONGTYPE Operation against a key holding the wrong kind of value (${key} is a ${actual}, not a ${type})`,
      );
    }
  }

  private zset(key: string) {
    this.assertType(key, "zset");
    let set = this.sortedSets.get(key);
    if (!set) {
      set = new Map();
      this.sortedSets.set(key, set);
    }
    return set;
  }

  private hash(key: string) {
    this.assertType(key, "hash");
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  async set(key: string, value: unknown, ...args: unknown[]) {
    this.expireIfDue(key);
    this.assertType(key, "string");

    const flag = (name: string) =>
      args.some((arg) => typeof arg === "string" && arg.toUpperCase() === name);

    if (flag("NX") && this.strings.has(key)) {
      return null;
    }

    if (flag("XX") && !this.strings.has(key)) {
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
    this.assertType(key, "string");
    return this.strings.get(key) ?? null;
  }

  async del(key: string) {
    this.expiries.delete(key);
    const existed = [
      this.strings.delete(key),
      this.hashes.delete(key),
      this.sortedSets.delete(key),
    ].some(Boolean);
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

  async persist(key: string) {
    this.expireIfDue(key);
    return this.expiries.delete(key) ? 1 : 0;
  }

  /** Seconds left on a key's expiry, as redis TTL reports it. */
  async ttl(key: string) {
    this.expireIfDue(key);
    if (!this.has(key) && !this.sortedSets.has(key)) {
      return -2;
    }
    const deadline = this.expiries.get(key);
    return deadline === undefined
      ? -1
      : Math.ceil((deadline - this.clock) / 1000);
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

  private readZset(key: string) {
    this.assertType(key, "zset");
    return this.sortedSets.get(key) ?? new Map<string, number>();
  }

  private removeMember(key: string, member: string) {
    const set = this.readZset(key);
    const removed = set.delete(member);
    if (set.size === 0) {
      this.sortedSets.delete(key);
    }
    return removed ? 1 : 0;
  }

  async zrem(key: string, member: string) {
    return this.removeMember(key, member);
  }

  async zscore(key: string, member: string) {
    const score = this.readZset(key).get(member);
    return score === undefined ? null : String(score);
  }

  async zrank(key: string, member: string) {
    const rank = [...this.readZset(key).entries()]
      .sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0].localeCompare(b[0])))
      .findIndex(([entry]) => entry === member);
    return rank === -1 ? null : rank;
  }

  async zcard(key: string) {
    return this.readZset(key).size;
  }

  async zrange(key: string, start: number, stop: number, withScores?: string) {
    const entries = [...this.readZset(key).entries()].sort((a, b) =>
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

  // Reads never create the key, and a hash goes with its last field, as in
  // redis.
  async hget(key: string, field: string) {
    this.assertType(key, "hash");
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string) {
    this.assertType(key, "hash");
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hdel(key: string, field: string) {
    this.assertType(key, "hash");
    const hash = this.hashes.get(key);
    const removed = hash?.delete(field) ?? false;
    if (hash?.size === 0) {
      this.hashes.delete(key);
    }
    return removed ? 1 : 0;
  }

  async publish(channel: string, message: string) {
    this.published.push({ channel, message });
    return 1;
  }

  /**
   * The redis EVAL command, not javascript eval. The lua source is not
   * interpreted - this hardcodes the scripts it knows, recognised by text only
   * they contain. None of them awaits anything, so each runs in one go, which
   * is the property the real scripts buy with lua.
   */
  async eval(script: string, numKeys: number, ...args: unknown[]) {
    const keys = args.slice(0, numKeys) as string[];
    const argv = args.slice(numKeys).map(String);

    if (script.includes("'NX'")) {
      return this.claimLobby(keys, argv);
    }

    if (script.includes("'details', 'confirmationId'")) {
      return this.removeLobby(keys, argv);
    }

    if (script.includes("queuedIn")) {
      return this.dropStrayEntries(keys, argv);
    }

    if (script.includes("'HEXISTS', KEYS[1], 'matchId'")) {
      return this.claimReadyCheckForCancel(keys, argv);
    }

    if (script.includes("'HDEL', KEYS[1], 'confirmationId'")) {
      return this.takeLobbyStamp(keys, argv);
    }

    if (script.includes("'DEL', KEYS[1]")) {
      return this.releaseLock(keys, argv);
    }

    throw new Error(
      `FakeRedis does not emulate this script, test it against a real redis: ${script.trim().split("\n")[0]}`,
    );
  }

  private detailsIn(key: string) {
    this.assertType(key, "hash");
    return this.hashes.get(key)?.get("details");
  }

  private claimLobby(
    [lock, details, ...queues]: string[],
    [member, ttl, joinedAt]: string[],
  ) {
    const raw = this.detailsIn(details);
    if (!raw || JSON.parse(raw).joinedAt !== joinedAt) {
      return 0;
    }

    if (!queues.some((key) => this.readZset(key).has(member))) {
      return 0;
    }

    this.assertType(lock, "string");
    if (this.strings.has(lock)) {
      return 0;
    }
    this.strings.set(lock, "1");
    this.expiries.set(lock, this.clock + Number(ttl) * 1000);

    for (const key of queues) {
      this.removeMember(key, member);
    }

    return 1;
  }

  private removeLobby(
    [details, ...queues]: string[],
    [member, expected]: string[],
  ) {
    if ((this.detailsIn(details) ?? "") !== expected) {
      return 0;
    }

    for (const key of queues) {
      this.removeMember(key, member);
    }

    const hash = this.hashes.get(details);
    hash?.delete("details");
    hash?.delete("confirmationId");
    if (hash?.size === 0) {
      this.hashes.delete(details);
    }

    return 1;
  }

  private dropStrayEntries(
    [details, ...queues]: string[],
    [member, type, ...regions]: string[],
  ) {
    const raw = this.detailsIn(details);
    const lobby = raw ? JSON.parse(raw) : undefined;

    let dropped = 0;
    regions.forEach((region, index) => {
      if (lobby?.type === type && lobby.regions.includes(region)) {
        return;
      }

      dropped += this.removeMember(queues[2 * index], member);
      dropped += this.removeMember(queues[2 * index + 1], member);
    });

    return dropped;
  }

  private claimReadyCheckForCancel(
    [readyCheck, claim]: string[],
    [creating, cancelling, ttl]: string[],
  ) {
    this.assertType(readyCheck, "hash");
    if (this.hashes.get(readyCheck)?.has("matchId")) {
      return 0;
    }

    this.assertType(claim, "string");
    const holder = this.strings.get(claim);
    if (holder === creating) {
      return 0;
    }

    if (holder === undefined) {
      this.strings.set(claim, cancelling);
      this.expiries.set(claim, this.clock + Number(ttl) * 1000);
    }

    return 1;
  }

  private takeLobbyStamp([details]: string[], [confirmationId]: string[]) {
    this.assertType(details, "hash");
    const hash = this.hashes.get(details);
    if (hash?.get("confirmationId") !== confirmationId) {
      return 0;
    }

    hash.delete("confirmationId");
    if (hash.size === 0) {
      this.hashes.delete(details);
    }
    return 1;
  }

  private releaseLock([lock]: string[], [token]: string[]) {
    this.assertType(lock, "string");
    if (this.strings.get(lock) !== token) {
      return 0;
    }

    this.expiries.delete(lock);
    this.strings.delete(lock);
    return 1;
  }

  // --- test helpers

  members(key: string) {
    return [...this.readZset(key).keys()].sort();
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
