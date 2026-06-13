-- Rename the table to player_trades. Idempotent + state-proof:
--   * env where the old table exists (prior migration applied) -> rename it
--   * fresh env where 1845 already created player_trades         -> rename is a no-op
ALTER TABLE IF EXISTS public.player_trade_stats_demo RENAME TO player_trades;

CREATE TABLE IF NOT EXISTS public.player_trades (
  match_id                   uuid    NOT NULL,
  match_map_id               uuid    NOT NULL,
  steam_id                   bigint  NOT NULL,
  trade_kill_opportunities   integer NOT NULL DEFAULT 0,
  trade_kill_attempts        integer NOT NULL DEFAULT 0,
  trade_kill_successes       integer NOT NULL DEFAULT 0,
  traded_death_opportunities integer NOT NULL DEFAULT 0,
  traded_death_attempts      integer NOT NULL DEFAULT 0,
  traded_death_successes     integer NOT NULL DEFAULT 0,
  util_on_death_sum          integer NOT NULL DEFAULT 0,
  util_on_death_count        integer NOT NULL DEFAULT 0,
  CONSTRAINT player_trades_pkey PRIMARY KEY (match_map_id, steam_id),
  CONSTRAINT player_trades_match_map_id_fkey
    FOREIGN KEY (match_map_id) REFERENCES public.match_maps(id) ON DELETE CASCADE,
  CONSTRAINT player_trades_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE
);

ALTER TABLE public.player_trades
  ADD COLUMN IF NOT EXISTS util_on_death_sum   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS util_on_death_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_player_trades_match_map ON public.player_trades (match_map_id);
