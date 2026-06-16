-- Per-weapon-class aim accuracy: one row per (map, player, class).
CREATE TABLE IF NOT EXISTS public.player_aim_weapon_stats (
  match_id           uuid NOT NULL,
  match_map_id       uuid NOT NULL,
  steam_id           bigint NOT NULL,
  weapon_class       text NOT NULL,          -- 'rifle' | 'pistol' | 'sniper'
  shots              integer NOT NULL DEFAULT 0,
  hits               integer NOT NULL DEFAULT 0,
  shots_spotted      integer NOT NULL DEFAULT 0,
  hits_spotted       integer NOT NULL DEFAULT 0,
  first_bullet_shots integer NOT NULL DEFAULT 0,
  first_bullet_hits  integer NOT NULL DEFAULT 0,
  CONSTRAINT player_aim_weapon_stats_pkey
    PRIMARY KEY (match_map_id, steam_id, weapon_class),
  CONSTRAINT player_aim_weapon_stats_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_aim_weapon_stats_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS player_aim_weapon_stats_match_id_idx
  ON public.player_aim_weapon_stats (match_id);
CREATE INDEX IF NOT EXISTS player_aim_weapon_stats_steam_id_idx
  ON public.player_aim_weapon_stats (steam_id);

-- Whether a collision mesh was available, so LOS-gated stats are validated.
ALTER TABLE public.match_map_demos
  ADD COLUMN IF NOT EXISTS geometry_validated boolean;
