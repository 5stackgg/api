export type RegistryVersion = {
  version: string;
  runtime: string;
  url: string;
  sha256: string;
  size?: number;
  published_at: string;
  prerelease?: boolean;
  layout?: "csgo" | "plugin";
  install_path?: string;
};

export type RegistryPlugin = {
  slug: string;
  kind: "game" | "panel" | "bundle";
  name: string;
  author: string;
  description: string;
  homepage?: string;
  tags?: Array<string>;
  verified?: boolean;
  hot_swappable?: boolean;
  requires_service?: string | null;
  config_schema?: Record<string, unknown>;
  config_path?: string;
  cvars?: Array<string>;
  panel?: Record<string, unknown>;
  wiring?: Record<string, unknown>;
  pairs_with?: Array<string>;
  versions?: Array<RegistryVersion>;
};

export type RegistryIndex = {
  version: number;
  generated_at: string;
  plugins: Array<RegistryPlugin>;
};

export type NodeInventoryPlugin = {
  slug: string;
  version: string | null;
  runtime: string | null;
  source: "managed" | "manual";
  path: string;
  files: Array<string>;
  digest: string | null;
};
