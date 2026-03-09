export function createMockRedisConnection() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),

    set: jest.fn(async (...args: any[]) => {
      const [key, value] = args;
      const hasNX = args.includes("NX");

      if (hasNX && store.has(key)) {
        return null;
      }

      store.set(key, String(value));

      const exIndex = args.indexOf("EX");
      if (exIndex !== -1) {
        ttls.set(key, args[exIndex + 1]);
      }

      return "OK";
    }),

    del: jest.fn(async (key: string) => {
      const existed = store.has(key) ? 1 : 0;
      store.delete(key);
      ttls.delete(key);
      return existed;
    }),

    expire: jest.fn(async (key: string, seconds: number) => {
      if (store.has(key)) {
        ttls.set(key, seconds);
        return 1;
      }
      return 0;
    }),

    // Expose internals for test assertions
    _store: store,
    _ttls: ttls,
  };
}

export function createMockRedisManager(connection?: ReturnType<typeof createMockRedisConnection>) {
  const conn = connection ?? createMockRedisConnection();
  return {
    getConnection: jest.fn().mockReturnValue(conn),
    _connection: conn,
  };
}
