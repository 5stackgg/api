-- Squashed schema additions for the match-stats expansion:
--   • HLTV 2.0 + KAST view             (indexes only — view in /views/)
--   • Head-to-Head view                (indexes only — view in /views/)
--   • traded_death_attempts            new column on player_match_map_stats
--   • he_team_damage                   new column on player_match_map_stats
--   • Wasted Magazine %                ammo_in_magazine on player_shots_fired
--                                      + wasted_magazine_shots aggregate
--   • Per-side splits                  kills_t/ct, hs_kills_t/ct, deaths_t/ct,
--                                      damage_t/ct, assists_t/ct, rounds_t/ct
--   • Avg Unused Utility ($)           new player_round_inventory table
--                                      + unused_utility_value aggregate
--   • 2D replay positions              new player_positions table (~4Hz)

-- ── Extra aggregate columns on player_match_map_stats ───────────────
ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS traded_death_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS he_team_damage        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wasted_magazine_shots integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unused_utility_value  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kills_t      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kills_ct     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hs_kills_t   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hs_kills_ct  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deaths_t     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deaths_ct    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_t     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_ct    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assists_t    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assists_ct   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounds_t     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounds_ct    integer NOT NULL DEFAULT 0;

-- ── ammo tracking for Wasted Magazine % ─────────────────────────────
ALTER TABLE public.player_shots_fired
  ADD COLUMN IF NOT EXISTS ammo_in_magazine integer;

-- ── grenade inventory snapshot (drives unused_utility_value) ────────
CREATE TABLE IF NOT EXISTS public.player_round_inventory (
  id                uuid DEFAULT gen_random_uuid() NOT NULL,
  match_id          uuid NOT NULL,
  match_map_id      uuid NOT NULL,
  round             integer NOT NULL,
  attacker_steam_id bigint NOT NULL,
  attacker_team     text,
  flash             integer NOT NULL DEFAULT 0,
  smoke             integer NOT NULL DEFAULT 0,
  he                integer NOT NULL DEFAULT 0,
  molotov           integer NOT NULL DEFAULT 0,
  decoy             integer NOT NULL DEFAULT 0,
  CONSTRAINT player_round_inventory_pkey PRIMARY KEY (id),
  CONSTRAINT player_round_inventory_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_round_inventory_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_player_round_inventory_mm_attacker
  ON public.player_round_inventory (match_map_id, attacker_steam_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_player_round_inventory_mm_round_attacker
  ON public.player_round_inventory (match_map_id, round, attacker_steam_id);

-- ── per-player position samples for 2D replay ───────────────────────
CREATE TABLE IF NOT EXISTS public.player_positions (
  id                bigserial PRIMARY KEY,
  match_id          uuid NOT NULL,
  match_map_id      uuid NOT NULL,
  round             integer NOT NULL,
  tick              integer NOT NULL,
  attacker_steam_id bigint NOT NULL,
  attacker_team     text,
  alive             boolean NOT NULL DEFAULT true,
  x                 real NOT NULL,
  y                 real NOT NULL,
  z                 real NOT NULL,
  yaw               real,
  CONSTRAINT player_positions_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_positions_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

-- ── indexes that views in /views/ depend on ─────────────────────────
-- v_player_match_map_hltv (KAST per-round lookups)
CREATE INDEX IF NOT EXISTS idx_player_kills_map_round_attacker
  ON public.player_kills (match_map_id, round, attacker_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_kills_map_round_attacked
  ON public.player_kills (match_map_id, round, attacked_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_assists_map_round_attacker
  ON public.player_assists (match_map_id, round, attacker_steam_id);

-- v_player_match_head_to_head (per-pair aggregation)
CREATE INDEX IF NOT EXISTS idx_player_kills_match_pair
  ON public.player_kills (match_id, attacker_steam_id, attacked_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_damages_match_pair
  ON public.player_damages (match_id, attacker_steam_id, attacked_steam_id);

-- Wasted-magazine sub-aggregation (ordered traversal per round)
CREATE INDEX IF NOT EXISTS idx_player_shots_fired_mm_attacker_round_tick
  ON public.player_shots_fired (match_map_id, attacker_steam_id, round, tick);

-- player_positions playback queries
CREATE INDEX IF NOT EXISTS idx_player_positions_mm_round_tick
  ON public.player_positions (match_map_id, round, tick);
CREATE INDEX IF NOT EXISTS idx_player_positions_mm_attacker
  ON public.player_positions (match_map_id, attacker_steam_id);
