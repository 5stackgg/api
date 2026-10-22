-- A player's tournament ELO is their latest season-less row whose match sits in
-- a tournament bracket. Finding it meant walking every season-less row newest
-- first and probing the brackets for each, so a long pre-seasons history made
-- every players.elo read slow. The row now says so itself, kept current by
-- hasura/triggers/player_elo_is_tournament.sql, and a partial index finds it.
ALTER TABLE public.player_elo
    ADD COLUMN IF NOT EXISTS is_tournament boolean NOT NULL DEFAULT false;

-- Without the Hasura event trigger, so the backfill sends no player_elo event
-- per row (the column changes no rating).
DO $$
DECLARE
    _hasura_update boolean := EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.player_elo'::regclass
          AND tgname = 'notify_hasura_player_elo_events_UPDATE'
    );
BEGIN
    IF _hasura_update THEN
        EXECUTE 'ALTER TABLE public.player_elo DISABLE TRIGGER "notify_hasura_player_elo_events_UPDATE"';
    END IF;

    UPDATE public.player_elo pe
    SET is_tournament = true
    WHERE EXISTS (
        SELECT 1 FROM public.tournament_brackets tb WHERE tb.match_id = pe.match_id
    );

    IF _hasura_update THEN
        EXECUTE 'ALTER TABLE public.player_elo ENABLE TRIGGER "notify_hasura_player_elo_events_UPDATE"';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_player_elo_tournament
    ON public.player_elo (steam_id, type, created_at DESC)
    INCLUDE ("current", match_id)
    WHERE season_id IS NULL AND is_tournament;
