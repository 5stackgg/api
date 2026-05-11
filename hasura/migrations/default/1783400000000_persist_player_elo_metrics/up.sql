-- Persist per-match metrics that v_player_elo used to recompute on every read via
-- get_elo_for_match(). With these columns populated the view becomes a thin
-- projection over player_elo, and the (steam_id, type, created_at DESC) index
-- can drive elo_history lookups end-to-end.

ALTER TABLE public.player_elo
  ADD COLUMN IF NOT EXISTS actual_score             double precision,
  ADD COLUMN IF NOT EXISTS expected_score           double precision,
  ADD COLUMN IF NOT EXISTS k_factor                 integer,
  ADD COLUMN IF NOT EXISTS player_team_elo_avg      double precision,
  ADD COLUMN IF NOT EXISTS opponent_team_elo_avg    double precision,
  ADD COLUMN IF NOT EXISTS kills                    integer,
  ADD COLUMN IF NOT EXISTS deaths                   integer,
  ADD COLUMN IF NOT EXISTS assists                  integer,
  ADD COLUMN IF NOT EXISTS damage                   integer,
  ADD COLUMN IF NOT EXISTS kda                      double precision,
  ADD COLUMN IF NOT EXISTS team_avg_kda             double precision,
  ADD COLUMN IF NOT EXISTS damage_percent           double precision,
  ADD COLUMN IF NOT EXISTS performance_multiplier   double precision,
  ADD COLUMN IF NOT EXISTS map_wins                 integer,
  ADD COLUMN IF NOT EXISTS map_losses               integer,
  ADD COLUMN IF NOT EXISTS series_multiplier        integer;

-- Backfill existing rows by recomputing once. get_player_elo_for_match is
-- deterministic w.r.t. (match, player) so this matches what fresh inserts
-- will now persist on their own.
WITH calc AS (
  SELECT
    pe.steam_id,
    pe.match_id,
    pe."type",
    public.get_player_elo_for_match(m, p) AS elo_data
  FROM public.player_elo pe
  JOIN public.matches m ON m.id = pe.match_id
  JOIN public.players p ON p.steam_id = pe.steam_id
  WHERE pe.kills IS NULL
)
UPDATE public.player_elo pe
SET
  actual_score           = (calc.elo_data->>'actual_score')::double precision,
  expected_score         = (calc.elo_data->>'expected_score')::double precision,
  k_factor               = (calc.elo_data->>'k_factor')::integer,
  player_team_elo_avg    = (calc.elo_data->>'player_team_elo_avg')::double precision,
  opponent_team_elo_avg  = (calc.elo_data->>'opponent_team_elo_avg')::double precision,
  kills                  = (calc.elo_data->>'kills')::integer,
  deaths                 = (calc.elo_data->>'deaths')::integer,
  assists                = (calc.elo_data->>'assists')::integer,
  damage                 = (calc.elo_data->>'damage')::integer,
  kda                    = (calc.elo_data->>'kda')::double precision,
  team_avg_kda           = (calc.elo_data->>'team_avg_kda')::double precision,
  damage_percent         = (calc.elo_data->>'damage_percent')::double precision,
  performance_multiplier = (calc.elo_data->>'performance_multiplier')::double precision,
  map_wins               = (calc.elo_data->>'map_wins')::integer,
  map_losses             = (calc.elo_data->>'map_losses')::integer,
  series_multiplier      = (calc.elo_data->>'series_multiplier')::integer
FROM calc
WHERE pe.steam_id = calc.steam_id
  AND pe.match_id = calc.match_id
  AND pe."type"   = calc."type";
