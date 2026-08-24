export const TELEMETRY_SCHEMA_VERSION = 5;

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
    // Outcomes of the matches counted in `total`, so they decompose it:
    // abandoned counts a match that went live and never reached a result.
    // Null on the way in from a panel built before these existed, which is not
    // the same as a panel reporting that nothing has ever finished.
    finished: number | null;
    abandoned: number | null;
    live: number | null;
    // by_type decomposes `total`; by_source spans hosted and imported both,
    // since naming the source is the only thing it is for.
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
    // Player-map rows, so `appearances / played` is how many maps the average
    // player has actually turned up for. Without it a big match count says
    // nothing about whether it is a community or the same ten people. Null
    // from a panel built before it existed.
    appearances: number | null;
    active_7d: number;
    active_30d: number;
    teams: number;
  };
  // Absent on a panel built before this section existed, and left absent
  // rather than zero-filled -- a fleet total that quietly counts non-reporters
  // as zeroes is the same lie as reporting a feature nobody measures as unused.
  competition: TelemetryCompetition | null;
  // Which catalog plugins operators actually run. The registry says what
  // exists; only this says what anybody chose, which is the one trust signal a
  // directory can offer beyond a single maintainer's `verified` flag.
  //
  // Absent from a panel built before this section existed, rather than
  // zero-filled: a panel running no plugins and a panel that cannot report them
  // are different facts, and averaging the second in as zero understates every
  // plugin in the catalog.
  plugins: TelemetryPlugins | null;
  // The utility library and the practice servers that feed it. Absent from a
  // panel built before the section existed rather than zero-filled, for the
  // same reason `competition` is.
  utility: TelemetryUtility | null;
  features: Record<string, TelemetryFeature>;
};

export type TelemetryPlugins = {
  // Catalog plugins this panel has asked to be installed.
  requested: number;
  // slug -> how many of this panel's nodes actually have it on disk. Named
  // rather than counted, because ranking the catalog is the whole point.
  by_slug: Record<string, number>;
  // Plugin folders found on nodes that the catalog does not know about --
  // hand-placed, so unnameable. Counted only so the fleet view does not read
  // as if managed installs were the whole story.
  manual: number;
  modes: number;
  modes_enabled: number;
  // Modes that are not competitive_safe, i.e. not offered in draft lobbies.
  // Every custom mode is unranked regardless; the key predates that rule and
  // stays so already-recorded payloads keep summing.
  modes_unranked: number;
};

// Match counts for each of these live under `matches`; this is the shape of the
// competition itself -- how many were run, how many finished, who entered.
export type TelemetryCompetition = {
  tournaments: number;
  tournaments_finished: number;
  tournament_teams: number;
  league_seasons: number;
  league_seasons_finished: number;
  league_registrations: number;
  league_teams: number;
  scrim_requests: number;
  events: number;
  event_teams: number;
};

// A lineup is one throw somebody wrote up; a throw is one grenade somebody
// actually threw. Nothing here counts both, and the two are never added
// together -- the library is what people chose to keep, the mined throws are
// what a demo happened to contain.
export type TelemetryUtility = {
  // Archived lineups are excluded from every count except `archived`: the
  // author can still see them, but they are out of the library.
  lineups: number;
  archived: number;
  week: number;
  month: number;
  // Visibility decomposes `lineups`. Public is what the whole panel can see,
  // which is not the same as reviewed -- see `pending_review`.
  public: number;
  team: number;
  private: number;
  // Distinct authors and distinct maps, which is what separates a library one
  // person filled in from one a community wrote.
  authors: number;
  maps: number;
  // Derived by trigger once enough separate players have mastered a lineup in
  // a practice server, so it is a fact about the throw rather than a badge an
  // admin handed out.
  verified: number;
  pending_review: number;
  // Lineups carrying a rendered preview clip, i.e. how much of the library the
  // render pipeline has actually filmed.
  previews: number;
  favorites: number;
  votes: number;
  collections: number;
  playbooks: number;
  playbook_steps: number;
  // Which grenade, and how the lineup came to exist -- plugin (recorded from a
  // real throw), demo (mined), editor (typed), import, fork. The second is the
  // one that says whether the in-game recorder is what people use.
  by_type: Record<string, number>;
  by_source: Record<string, number>;

  sessions: number;
  sessions_week: number;
  sessions_month: number;
  // Never came up. A panel with no spare on-demand slots reports its shortage
  // here rather than anywhere in the server counts.
  sessions_failed: number;
  hosts: number;
  // Distinct players with a progress row, and the throws behind it. attempts
  // and successes are counted per throw by the practice plugin, so their ratio
  // is a real hit rate rather than a self-assessment.
  practicing: number;
  attempts: number;
  successes: number;
  mastered: number;

  demos_mined: number;
  demo_throws: number;
  meta_lineups: number;
  drift_scans: number;
  // Lineups a drift scan has ever called moved or broken, counted once each.
  // Not how many are broken now: a repaired lineup keeps the verdict that sent
  // it to be repaired.
  drift_flagged: number;
  repairs: number;
};
