import { createHmac } from "crypto";

// Short-lived token the worker verifies before signing a multipart part PUT.
// Binds the token to the exact object key + multipart uploadId so a leaked
// token can't be replayed against a different upload, and expires so it can't
// be reused after the session is done. 6h covers a slow 500MB upload.
const UPLOAD_TOKEN_TTL_SECONDS = 6 * 60 * 60;

export function signUploadToken(
  secret: string,
  key: string,
  uploadId: string,
  now: number = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ k: key, u: uploadId, exp }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
