import { isJsonEqual } from "./isJsonEqual";

describe("isJsonEqual", () => {
  describe("primitives", () => {
    it("returns true for identical primitives", () => {
      expect(isJsonEqual(1, 1)).toBe(true);
      expect(isJsonEqual("hello", "hello")).toBe(true);
      expect(isJsonEqual(true, true)).toBe(true);
      expect(isJsonEqual(null, null)).toBe(true);
    });

    it("returns false for different primitives", () => {
      expect(isJsonEqual(1, 2)).toBe(false);
      expect(isJsonEqual("a", "b")).toBe(false);
      expect(isJsonEqual(true, false)).toBe(false);
    });

    it("returns false for different types", () => {
      expect(isJsonEqual(1, "1")).toBe(false);
      expect(isJsonEqual(null, undefined)).toBe(false);
      expect(isJsonEqual(0, false)).toBe(false);
    });
  });

  describe("null handling", () => {
    it("returns false when one side is null and the other is not", () => {
      expect(isJsonEqual(null, {})).toBe(false);
      expect(isJsonEqual({}, null)).toBe(false);
      expect(isJsonEqual(null, "string")).toBe(false);
    });
  });

  describe("arrays", () => {
    it("returns true for identical arrays", () => {
      expect(isJsonEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(isJsonEqual([], [])).toBe(true);
    });

    it("returns false for arrays with different lengths", () => {
      expect(isJsonEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it("returns false for arrays with different elements", () => {
      expect(isJsonEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it("returns false when one is array and the other is not", () => {
      expect(isJsonEqual([1], { 0: 1 })).toBe(false);
      expect(isJsonEqual({ 0: 1 }, [1])).toBe(false);
    });

    it("handles nested arrays", () => {
      expect(isJsonEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
      expect(isJsonEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
    });
  });

  describe("objects", () => {
    it("returns true for identical objects", () => {
      expect(isJsonEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
      expect(isJsonEqual({}, {})).toBe(true);
    });

    it("returns true regardless of key order", () => {
      expect(isJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it("returns false for objects with different key counts", () => {
      expect(isJsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it("returns false for objects with different keys", () => {
      expect(isJsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it("returns false for objects with different values", () => {
      expect(isJsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it("handles deeply nested objects", () => {
      const a = { x: { y: { z: 1 } } };
      const b = { x: { y: { z: 1 } } };
      const c = { x: { y: { z: 2 } } };
      expect(isJsonEqual(a, b)).toBe(true);
      expect(isJsonEqual(a, c)).toBe(false);
    });
  });

  describe("reference equality shortcut", () => {
    it("returns true for same reference", () => {
      const obj = { a: 1 };
      expect(isJsonEqual(obj, obj)).toBe(true);
    });
  });
});
