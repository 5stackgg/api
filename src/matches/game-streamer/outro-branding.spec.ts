import {
  DEFAULT_OUTRO_ACCENT,
  computeOutroVersion,
  outroCacheKey,
  buildOutroEnv,
  clipOutputFromSpec,
  sharedClipOutput,
} from "./outro-branding";

describe("outro-branding", () => {
  it("default accent is the stock amber triple", () => {
    expect(DEFAULT_OUTRO_ACCENT).toBe("33 94% 58%");
  });

  it("version is deterministic and 12 chars", () => {
    const a = computeOutroVersion({
      brandName: "ACME",
      accent: "1 2% 3%",
      etag: "e1",
    });
    const b = computeOutroVersion({
      brandName: "ACME",
      accent: "1 2% 3%",
      etag: "e1",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("version changes when the logo etag changes", () => {
    const a = computeOutroVersion({
      brandName: "ACME",
      accent: "1 2% 3%",
      etag: "e1",
    });
    const b = computeOutroVersion({
      brandName: "ACME",
      accent: "1 2% 3%",
      etag: "e2",
    });
    expect(a).not.toBe(b);
  });

  it("cache key embeds version + dims + fps", () => {
    expect(
      outroCacheKey({ version: "abc123abc123", dims: "1920x1080", fps: 60 }),
    ).toBe("branding/outro_abc123abc123_1920x1080_60.mp4");
  });

  it("hit env is just the cache URL", () => {
    expect(buildOutroEnv({ hit: true, cacheUrl: "http://s3/x.mp4" })).toEqual({
      CLIP_OUTRO_URL: "http://s3/x.mp4",
    });
  });

  it("miss env carries render instruction + branding props", () => {
    expect(
      buildOutroEnv({
        hit: false,
        putUrl: "http://put",
        logoUrl: "http://logo",
        brandName: "ACME",
        accent: "33 94% 58%",
      }),
    ).toEqual({
      CLIP_OUTRO_RENDER: "1",
      CLIP_OUTRO_PUT_URL: "http://put",
      CLIP_BRAND_LOGO_URL: "http://logo",
      CLIP_BRAND_NAME: "ACME",
      CLIP_BRAND_ACCENT: "33 94% 58%",
    });
  });

  it("clip output mirrors the pod's job-fields", () => {
    expect(
      clipOutputFromSpec({ output: { resolution: "720p", fps: 30 } }),
    ).toEqual({ dims: "1280x720", fps: 30 });
    expect(
      clipOutputFromSpec({ output: { resolution: "1080p", fps: 60 } }),
    ).toEqual({ dims: "1920x1080", fps: 60 });
    expect(clipOutputFromSpec({})).toEqual({ dims: "1920x1080", fps: 60 });
    expect(clipOutputFromSpec(null)).toEqual({ dims: "1920x1080", fps: 60 });
  });

  it("shared clip output is the output every spec has", () => {
    const hd30 = { output: { resolution: "720p", fps: 30 } };
    expect(sharedClipOutput([hd30, hd30])).toEqual({
      dims: "1280x720",
      fps: 30,
    });
  });

  it("shared clip output is null when the specs differ or there are none", () => {
    const hd30 = { output: { resolution: "720p", fps: 30 } };
    expect(
      sharedClipOutput([hd30, { output: { resolution: "720p", fps: 60 } }]),
    ).toBeNull();
    expect(
      sharedClipOutput([hd30, { output: { resolution: "1080p", fps: 30 } }]),
    ).toBeNull();
    expect(sharedClipOutput([])).toBeNull();
  });
});
