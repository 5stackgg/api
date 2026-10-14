import { timingSafeEqual } from "crypto";

export function timingSafeStringEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
