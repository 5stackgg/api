-- Indexes
DROP INDEX IF EXISTS public.idx_player_positions_mm_attacker;
DROP INDEX IF EXISTS public.idx_player_positions_mm_round_tick;
DROP INDEX IF EXISTS public.idx_player_shots_fired_mm_attacker_round_tick;
DROP INDEX IF EXISTS public.idx_player_damages_match_pair;
DROP INDEX IF EXISTS public.idx_player_kills_match_pair;
DROP INDEX IF EXISTS public.idx_player_assists_map_round_attacker;
DROP INDEX IF EXISTS public.idx_player_kills_map_round_attacked;
DROP INDEX IF EXISTS public.idx_player_kills_map_round_attacker;
DROP INDEX IF EXISTS public.uq_player_round_inventory_mm_round_attacker;
DROP INDEX IF EXISTS public.idx_player_round_inventory_mm_attacker;

-- Tables
DROP TABLE IF EXISTS public.player_positions;
DROP TABLE IF EXISTS public.player_round_inventory;

-- Columns on existing tables
ALTER TABLE public.player_shots_fired
  DROP COLUMN IF EXISTS ammo_in_magazine;

ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS rounds_ct,
  DROP COLUMN IF EXISTS rounds_t,
  DROP COLUMN IF EXISTS assists_ct,
  DROP COLUMN IF EXISTS assists_t,
  DROP COLUMN IF EXISTS damage_ct,
  DROP COLUMN IF EXISTS damage_t,
  DROP COLUMN IF EXISTS deaths_ct,
  DROP COLUMN IF EXISTS deaths_t,
  DROP COLUMN IF EXISTS hs_kills_ct,
  DROP COLUMN IF EXISTS hs_kills_t,
  DROP COLUMN IF EXISTS kills_ct,
  DROP COLUMN IF EXISTS kills_t,
  DROP COLUMN IF EXISTS unused_utility_value,
  DROP COLUMN IF EXISTS wasted_magazine_shots,
  DROP COLUMN IF EXISTS he_team_damage,
  DROP COLUMN IF EXISTS traded_death_attempts;
