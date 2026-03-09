export function createMockHasuraService(overrides: Record<string, any> = {}) {
  return {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
    checkSecret: jest.fn().mockReturnValue(true),
    getHasuraHeaders: jest.fn().mockResolvedValue({
      "x-hasura-role": "user",
      "x-hasura-user-id": "test-steam-id",
    }),
    setup: jest.fn().mockResolvedValue(undefined),
    apply: jest.fn().mockResolvedValue(undefined),
    getSetting: jest.fn().mockResolvedValue(undefined),
    setSetting: jest.fn().mockResolvedValue(undefined),
    calcSqlDigest: jest.fn().mockReturnValue("mock-digest"),
    ...overrides,
  };
}
