export const TELEMETRY_SCHEMA_VERSION = 2;

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
    gpu: number;
  };
  // A `servers` row is not always a server. Enabling a game server node
  // pre-provisions one row per port pair in its range, so a single node adds
  // ~100 rows that are slots waiting on a match rather than machines. None of
  // these count them.
  servers: {
    total: number;
    enabled: number;
    dedicated: number;
    public: number;
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
  // `known` is every steam id the panel holds a row for, most of which never
  // belonged to a person who signed in — connect events, lineup syncs, demo
  // imports and sanctions all create players. `registered` is the subset that
  // has signed in at least once.
  players: {
    known: number;
    registered: number;
    played: number;
    active_7d: number;
    active_30d: number;
    teams: number;
  };
  features: Record<string, TelemetryFeature>;
};
