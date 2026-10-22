-- Keeps player_elo.is_tournament (migration 1890000001220) equal to whether the
-- row's match sits in a tournament bracket.
CREATE OR REPLACE FUNCTION public.tbiu_player_elo_is_tournament()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.is_tournament := EXISTS (
        SELECT 1 FROM public.tournament_brackets tb WHERE tb.match_id = NEW.match_id
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_player_elo_is_tournament ON public.player_elo;
CREATE TRIGGER tbiu_player_elo_is_tournament
    BEFORE INSERT OR UPDATE OF match_id ON public.player_elo
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_player_elo_is_tournament();

-- A bracket usually gets its match before the match is played, so this rarely
-- finds a rated row to change.
CREATE OR REPLACE FUNCTION public.taiud_tournament_brackets_player_elo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _match_ids uuid[] := ARRAY[]::uuid[];
BEGIN
    IF TG_OP <> 'INSERT' THEN
        _match_ids := _match_ids || OLD.match_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        _match_ids := _match_ids || NEW.match_id;
    END IF;

    UPDATE public.player_elo pe
    SET is_tournament = EXISTS (
        SELECT 1 FROM public.tournament_brackets tb WHERE tb.match_id = pe.match_id
    )
    WHERE pe.match_id = ANY (_match_ids)
      AND pe.is_tournament IS DISTINCT FROM EXISTS (
          SELECT 1 FROM public.tournament_brackets tb WHERE tb.match_id = pe.match_id
      );

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiud_tournament_brackets_player_elo ON public.tournament_brackets;
CREATE TRIGGER taiud_tournament_brackets_player_elo
    AFTER INSERT OR UPDATE OF match_id OR DELETE ON public.tournament_brackets
    FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_brackets_player_elo();
