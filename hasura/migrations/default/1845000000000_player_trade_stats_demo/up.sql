CREATE TABLE IF NOT EXISTS public.player_trade_stats_demo (
  match_id                   uuid    NOT NULL,
  match_map_id               uuid    NOT NULL,
  steam_id                   bigint  NOT NULL,
  trade_kill_opportunities   integer NOT NULL DEFAULT 0,
  trade_kill_attempts        integer NOT NULL DEFAULT 0,
  trade_kill_successes       integer NOT NULL DEFAULT 0,
  traded_death_opportunities integer NOT NULL DEFAULT 0,
  traded_death_attempts      integer NOT NULL DEFAULT 0,
  traded_death_successes     integer NOT NULL DEFAULT 0,
  CONSTRAINT player_trade_stats_demo_pkey
    PRIMARY KEY (match_map_id, steam_id),
  CONSTRAINT player_trade_stats_demo_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_trade_stats_demo_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_trade_stats_demo_match_map
  ON public.player_trade_stats_demo (match_map_id);
