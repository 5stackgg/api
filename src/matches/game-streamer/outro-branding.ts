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

export interface ClipOutput {
  dims: string;
  fps: number;
}

// The dims and fps the render pod gives a clip. Mirrors game-streamer's
// clip-helpers.mjs job-fields, which sets each batch job's CLIP_OUTPUT_DIMS
// and CLIP_OUTPUT_FPS from its spec.
export function clipOutputFromSpec(spec: unknown): ClipOutput {
  const output = (
    spec as { output?: { resolution?: unknown; fps?: unknown } } | null
  )?.output;
  const fps = Number.parseInt(String(output?.fps), 10);
  return {
    dims: output?.resolution === "720p" ? "1280x720" : "1920x1080",
    fps: Number.isFinite(fps) ? fps : 60,
  };
}

// The output every spec shares, or null when they differ (or there are none).
export function sharedClipOutput(specs: unknown[]): ClipOutput | null {
  const [first, ...rest] = specs.map((spec) => clipOutputFromSpec(spec));
  if (!first) {
    return null;
  }
  return rest.every((o) => o.dims === first.dims && o.fps === first.fps)
    ? first
    : null;
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
// narrow the union in the else branch; cast to the concrete variant instead.
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
