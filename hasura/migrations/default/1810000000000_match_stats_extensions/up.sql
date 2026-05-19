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

ALTER TABLE public.player_shots_fired
  ADD COLUMN IF NOT EXISTS ammo_in_magazine integer;

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

CREATE INDEX IF NOT EXISTS idx_player_kills_map_round_attacker
  ON public.player_kills (match_map_id, round, attacker_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_kills_map_round_attacked
  ON public.player_kills (match_map_id, round, attacked_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_assists_map_round_attacker
  ON public.player_assists (match_map_id, round, attacker_steam_id);

CREATE INDEX IF NOT EXISTS idx_player_kills_match_pair
  ON public.player_kills (match_id, attacker_steam_id, attacked_steam_id);
CREATE INDEX IF NOT EXISTS idx_player_damages_match_pair
  ON public.player_damages (match_id, attacker_steam_id, attacked_steam_id);

CREATE INDEX IF NOT EXISTS idx_player_shots_fired_mm_attacker_round_tick
  ON public.player_shots_fired (match_map_id, attacker_steam_id, round, tick);

CREATE INDEX IF NOT EXISTS idx_player_positions_mm_round_tick
  ON public.player_positions (match_map_id, round, tick);
CREATE INDEX IF NOT EXISTS idx_player_positions_mm_attacker
  ON public.player_positions (match_map_id, attacker_steam_id);
