-- Denormalized per-player per-map stats. One row per (steam_id, match_map_id).
-- Maintained by an AFTER INSERT/UPDATE/DELETE trigger on match_map_rounds, so
-- the table only updates at round-end (no mid-round leak) and is recomputed
-- atomically when a round is restored.
--
-- Reads in the GraphQL layer go from ~13 hypertable aggregates per player to
-- a single indexed row lookup — see player_match_stats_v
-- (hasura/views/player_match_stats_v.sql) for the all-maps rollup.
--
-- The recompute function, view, and trigger that maintain this table live in:
--   - hasura/functions/stats/recompute_player_match_map_stats.sql
--   - hasura/views/player_match_stats_v.sql
--   - hasura/triggers/match_map_rounds.sql
-- They're loaded after migrations on every boot (digest-tracked re-apply), so
-- iterating on the aggregation logic doesn't require a new migration.

CREATE TABLE IF NOT EXISTS public.player_match_map_stats (
  steam_id              bigint  NOT NULL,
  match_map_id          uuid    NOT NULL,
  match_id              uuid    NOT NULL,

  -- kills (attacker, non-team-kill unless noted)
  kills                 integer NOT NULL DEFAULT 0,
  hs_kills              integer NOT NULL DEFAULT 0,
  knife_kills           integer NOT NULL DEFAULT 0,
  zeus_kills            integer NOT NULL DEFAULT 0,

  -- assists
  assists               integer NOT NULL DEFAULT 0,
  flash_assists         integer NOT NULL DEFAULT 0,

  -- deaths
  deaths                integer NOT NULL DEFAULT 0,

  -- damage dealt (attacker)
  damage                integer NOT NULL DEFAULT 0,
  team_damage           integer NOT NULL DEFAULT 0,
  he_damage             integer NOT NULL DEFAULT 0,
  molotov_damage        integer NOT NULL DEFAULT 0,

  -- flashes (attacker side)
  flashes_thrown        integer NOT NULL DEFAULT 0,
  enemies_flashed       integer NOT NULL DEFAULT 0,
  team_flashed          integer NOT NULL DEFAULT 0,
  flash_duration_sum    numeric NOT NULL DEFAULT 0,
  flash_duration_count  integer NOT NULL DEFAULT 0,

  -- multi-kill round counts (mirror v_player_multi_kills.kills > 1, suicide-excluded)
  two_kill_rounds       integer NOT NULL DEFAULT 0,
  three_kill_rounds     integer NOT NULL DEFAULT 0,
  four_kill_rounds      integer NOT NULL DEFAULT 0,
  five_kill_rounds      integer NOT NULL DEFAULT 0,

  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT player_match_map_stats_pkey
    PRIMARY KEY (steam_id, match_map_id),
  CONSTRAINT player_match_map_stats_steam_id_fkey
    FOREIGN KEY (steam_id) REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT player_match_map_stats_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_match_map_stats_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_match_map_stats_match_id
  ON public.player_match_map_stats (match_id);

CREATE INDEX IF NOT EXISTS idx_player_match_map_stats_match_id_steam_id
  ON public.player_match_map_stats (match_id, steam_id);
