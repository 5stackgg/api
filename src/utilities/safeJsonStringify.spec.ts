import { safeJsonStringify } from "./safeJsonStringify";

describe("safeJsonStringify", () => {
  it("stringifies a simple object", () => {
    expect(safeJsonStringify({ a: 1, b: "hello" })).toBe(
      '{"a":1,"b":"hello"}',
    );
  });

  it("converts BigInt values to strings", () => {
    const obj = { id: BigInt("9007199254740993") } as Record<string, unknown>;
    const result = safeJsonStringify(obj);
    expect(result).toBe('{"id":"9007199254740993"}');
  });

  it("handles nested BigInt values", () => {
    const obj = {
      data: { count: BigInt(42) },
    } as Record<string, unknown>;
    const result = safeJsonStringify(obj);
    expect(result).toBe('{"data":{"count":"42"}}');
  });

  it("handles mixed types including BigInt", () => {
    const obj = {
      name: "test",
      count: BigInt(100),
      active: true,
    } as Record<string, unknown>;
    const result = safeJsonStringify(obj);
    expect(result).toBe('{"name":"test","count":"100","active":true}');
  });

  it("handles objects without BigInt normally", () => {
    const obj = { nested: { arr: [1, 2, 3] } };
    expect(safeJsonStringify(obj)).toBe('{"nested":{"arr":[1,2,3]}}');
  });

  it("handles empty objects", () => {
    expect(safeJsonStringify({})).toBe("{}");
  });
});
