export const TELEMETRY_SCHEMA_VERSION = 1;

export type TelemetryFeature = {
  enabled: boolean | null;
  count: number | null;
};

export type TelemetryPayload = {
  schema: number;
  install_id: string;
  installed_at: string | null;
  panel_version: string | null;
  plugin_runtime: string | null;
  nodes: {
    total: number;
    enabled: number;
    online: number;
    regions: number;
  };
  servers: {
    total: number;
    enabled: number;
    dedicated: number;
    on_demand: number;
    public: number;
    capacity: number;
  };
  // Everything outside `external` counts only matches this panel actually ran.
  // An imported demo is stamped with a started_at, so without the split it
  // would read as a match the panel hosted.
  matches: {
    total: number;
    created: number;
    week: number;
    month: number;
    year: number;
    maps_played: number;
    by_type: Record<string, number>;
    by_source: Record<string, number>;
    tournament: number;
    scrim: number;
    league: number;
    external: {
      total: number;
      week: number;
      month: number;
      year: number;
    };
  };
  players: {
    registered: number;
    active_7d: number;
    active_30d: number;
    teams: number;
  };
  features: Record<string, TelemetryFeature>;
};
