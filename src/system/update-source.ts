export const UPDATE_SOURCE_CONFIG_MAP = "5stack-update-source";
export const UPDATE_SOURCE_COMPONENTS = [
  "api",
  "web",
  "game-server-node-connector",
  "demo-parser",
  "game-streamer",
  "game-server-sw",
  "game-server-css",
] as const;

export type UpdateComponent = (typeof UPDATE_SOURCE_COMPONENTS)[number];
export type PanelSource = { repository: string; ref: string };
export type UpdateSource = {
  version: 1;
  mode: "installed" | "official" | "custom";
  channel?: "latest" | "beta";
  panel?: PanelSource | null;
  images?: Partial<Record<UpdateComponent, string>>;
};

export const installedUpdateSource = (): UpdateSource => ({
  version: 1,
  mode: "installed",
});

export function validImageReference(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || value !== value.trim())
    return false;
  return /^(?:(?:[a-z0-9.-]+(?::[0-9]+)?)\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/.test(
    value,
  );
}

export function validPanelSource(value: unknown): value is PanelSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { repository, ref } = value as PanelSource;
  return (
    typeof repository === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    !repository.includes("..") &&
    typeof ref === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock")
  );
}

export function parseUpdateSource(value: unknown): UpdateSource {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid update source");
  const input = value as UpdateSource;
  if (input.version !== 1) throw new Error("Unsupported update source version");
  if (input.mode === "installed") return installedUpdateSource();
  if (input.mode === "official") {
    if (input.channel !== "latest" && input.channel !== "beta")
      throw new Error("Choose stable or beta");
    return {
      version: 1,
      mode: "official",
      channel: input.channel,
      panel: {
        repository: "5stackgg/5stack-panel",
        ref: input.channel === "beta" ? "beta" : "main",
      },
    };
  }
  if (input.mode !== "custom") throw new Error("Unknown update source");
  if (input.panel != null && !validPanelSource(input.panel))
    throw new Error("Invalid panel repository or ref");
  if (
    !input.images ||
    typeof input.images !== "object" ||
    Array.isArray(input.images)
  )
    throw new Error("Custom image references are required");
  const images: Partial<Record<UpdateComponent, string>> = {};
  for (const [name, ref] of Object.entries(input.images)) {
    if (
      !(UPDATE_SOURCE_COMPONENTS as readonly string[]).includes(name) ||
      !validImageReference(ref)
    )
      throw new Error("Invalid custom image reference");
    images[name as UpdateComponent] = ref;
  }
  if (UPDATE_SOURCE_COMPONENTS.some((name) => !images[name]))
    throw new Error(
      "Set every custom core image; no official fallback is used",
    );
  return { version: 1, mode: "custom", panel: input.panel ?? null, images };
}

export function updateComponent(service: string): UpdateComponent | null {
  if (service === "hasura") return "api";
  if (service === "game-server-node-connector-nvidia")
    return "game-server-node-connector";
  return (UPDATE_SOURCE_COMPONENTS as readonly string[]).includes(service)
    ? (service as UpdateComponent)
    : null;
}

export function sourceImage(
  source: UpdateSource,
  service: string,
  installedImage: string,
): string {
  const component = updateComponent(service);
  if (!component || source.mode === "installed") return installedImage;
  if (source.mode === "official")
    return "ghcr.io/5stackgg/" + component + ":" + source.channel;
  return source.images?.[component] ?? "";
}

export function imageDigestReference(image: string): string | null {
  return /@sha256:[a-f0-9]{64}$/.test(image) ? image.split("@")[1] : null;
}

export function sourceLabel(source: UpdateSource): string {
  return source.mode === "official"
    ? "5stackgg/" + source.channel
    : source.mode;
}
