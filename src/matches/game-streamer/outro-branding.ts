import { createHash } from "node:crypto";

export const DEFAULT_OUTRO_ACCENT = "33 94% 58%";

export function computeOutroVersion(parts: {
  brandName: string;
  accent: string;
  etag: string;
}): string {
  return createHash("sha1")
    .update(`${parts.brandName}|${parts.accent}|${parts.etag}`)
    .digest("hex")
    .slice(0, 12);
}

export function outroCacheKey(args: {
  version: string;
  dims: string;
  fps: number;
}): string {
  return `branding/outro_${args.version}_${args.dims}_${args.fps}.mp4`;
}

export interface OutroEnvHit {
  hit: true;
  cacheUrl: string;
}
export interface OutroEnvMiss {
  hit: false;
  putUrl: string;
  logoUrl: string;
  brandName: string;
  accent: string;
}
export type OutroEnvState = OutroEnvHit | OutroEnvMiss;

// The api's tsconfig has strict mode off, so a boolean discriminant does not
// narrow the union in the else branch — cast to the concrete variant instead.
export function buildOutroEnv(state: OutroEnvState): Record<string, string> {
  if (state.hit) {
    return { CLIP_OUTRO_URL: (state as OutroEnvHit).cacheUrl };
  }
  const miss = state as OutroEnvMiss;
  return {
    CLIP_OUTRO_RENDER: "1",
    CLIP_OUTRO_PUT_URL: miss.putUrl,
    CLIP_BRAND_LOGO_URL: miss.logoUrl,
    CLIP_BRAND_NAME: miss.brandName,
    CLIP_BRAND_ACCENT: miss.accent,
  };
}
