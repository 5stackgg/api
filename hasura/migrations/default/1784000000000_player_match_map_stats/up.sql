CREATE TABLE IF NOT EXISTS public.player_match_map_stats (
  steam_id              bigint  NOT NULL,
  match_map_id          uuid    NOT NULL,
  match_id              uuid    NOT NULL,

  kills                 integer NOT NULL DEFAULT 0,
  hs_kills              integer NOT NULL DEFAULT 0,
  knife_kills           integer NOT NULL DEFAULT 0,
  zeus_kills            integer NOT NULL DEFAULT 0,

  assists               integer NOT NULL DEFAULT 0,
  flash_assists         integer NOT NULL DEFAULT 0,

  deaths                integer NOT NULL DEFAULT 0,

  damage                integer NOT NULL DEFAULT 0,
  team_damage           integer NOT NULL DEFAULT 0,
  he_damage             integer NOT NULL DEFAULT 0,
  molotov_damage        integer NOT NULL DEFAULT 0,

  flashes_thrown        integer NOT NULL DEFAULT 0,
  enemies_flashed       integer NOT NULL DEFAULT 0,
  team_flashed          integer NOT NULL DEFAULT 0,
  flash_duration_sum    numeric NOT NULL DEFAULT 0,
  flash_duration_count  integer NOT NULL DEFAULT 0,

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
