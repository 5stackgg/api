-- Organizers may edit a match_options row through whichever match, tournament,
-- stage or bracket points at it, so a client that could point its own row at
-- someone else's options would be handed that tournament's settings. A client
-- session may only attach options nothing else uses yet; the backend shares a
-- row on purpose (a scrim request or draft and the match made from it).
CREATE OR REPLACE FUNCTION public.match_options_claimed(
    _match_options_id uuid,
    _table text,
    _row_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (SELECT 1 FROM matches WHERE match_options_id = _match_options_id AND (_table <> 'matches' OR id <> _row_id))
        OR EXISTS (SELECT 1 FROM tournaments WHERE match_options_id = _match_options_id AND (_table <> 'tournaments' OR id <> _row_id))
        OR EXISTS (SELECT 1 FROM tournament_stages WHERE match_options_id = _match_options_id AND (_table <> 'tournament_stages' OR id <> _row_id))
        OR EXISTS (SELECT 1 FROM tournament_brackets WHERE match_options_id = _match_options_id AND (_table <> 'tournament_brackets' OR id <> _row_id))
        OR EXISTS (SELECT 1 FROM draft_games WHERE match_options_id = _match_options_id AND (_table <> 'draft_games' OR id <> _row_id))
        OR EXISTS (SELECT 1 FROM team_scrim_requests WHERE match_options_id = _match_options_id AND (_table <> 'team_scrim_requests' OR id <> _row_id))
        OR EXISTS (SELECT 1 FROM league_seasons WHERE match_options_id = _match_options_id AND (_table <> 'league_seasons' OR id <> _row_id));
$$;

CREATE OR REPLACE FUNCTION public.tbiu_claim_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.match_options_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.match_options_id IS NOT DISTINCT FROM OLD.match_options_id)
       OR COALESCE(
              nullif(current_setting('hasura.user', true), '')::jsonb ->> 'x-hasura-role',
              'admin'
          ) IN ('admin', 'administrator') THEN
        RETURN NEW;
    END IF;

    -- Held so two sessions attaching the same unattached row at once can't
    -- both see it free; the foreign key's own lock doesn't make them wait.
    PERFORM 1 FROM match_options WHERE id = NEW.match_options_id FOR NO KEY UPDATE;

    IF match_options_claimed(NEW.match_options_id, TG_TABLE_NAME, NEW.id) THEN
        RAISE EXCEPTION 'Those match options already belong to another match, tournament or draft' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;
