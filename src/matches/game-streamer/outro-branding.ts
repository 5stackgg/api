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

export type OutroEnvState =
  | { hit: true; cacheUrl: string }
  | {
      hit: false;
      putUrl: string;
      logoUrl: string;
      brandName: string;
      accent: string;
    };

export function buildOutroEnv(state: OutroEnvState): Record<string, string> {
  if (state.hit) {
    return { CLIP_OUTRO_URL: state.cacheUrl };
  }
  return {
    CLIP_OUTRO_RENDER: "1",
    CLIP_OUTRO_PUT_URL: state.putUrl,
    CLIP_BRAND_LOGO_URL: state.logoUrl,
    CLIP_BRAND_NAME: state.brandName,
    CLIP_BRAND_ACCENT: state.accent,
  };
}
