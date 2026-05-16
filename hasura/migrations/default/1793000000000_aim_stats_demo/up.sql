CREATE TABLE IF NOT EXISTS public.player_aim_stats_demo (
  match_id                       uuid NOT NULL,
  match_map_id                   uuid NOT NULL,
  attacker_steam_id              bigint NOT NULL,
  hits                           integer NOT NULL DEFAULT 0,
  headshot_hits                  integer NOT NULL DEFAULT 0,
  non_awp_hits                   integer NOT NULL DEFAULT 0,
  hits_at_spotted                integer NOT NULL DEFAULT 0,
  shots_at_spotted               integer NOT NULL DEFAULT 0,
  counter_strafe_eligible_shots  integer NOT NULL DEFAULT 0,
  counter_strafed_shots          integer NOT NULL DEFAULT 0,
  spray_shots                    integer NOT NULL DEFAULT 0,
  spray_hits                     integer NOT NULL DEFAULT 0,
  crosshair_angle_sum_deg        numeric NOT NULL DEFAULT 0,
  crosshair_angle_count          integer NOT NULL DEFAULT 0,
  time_to_damage_sum_s           numeric NOT NULL DEFAULT 0,
  time_to_damage_count           integer NOT NULL DEFAULT 0,
  CONSTRAINT player_aim_stats_demo_pkey
    PRIMARY KEY (match_map_id, attacker_steam_id),
  CONSTRAINT player_aim_stats_demo_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_aim_stats_demo_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS counter_strafed_shots          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counter_strafe_eligible_shots  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crosshair_angle_sum_deg        numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crosshair_angle_count          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS non_awp_hits                   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hits_at_spotted                integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shots_at_spotted               integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spray_shots                    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spray_hits                     integer NOT NULL DEFAULT 0;
