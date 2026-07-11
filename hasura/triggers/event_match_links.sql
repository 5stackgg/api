-- Keeps event_match_links (migration 1874) in sync with v_event_matches, the
-- single source of truth for "which matches belong to an event". Every input
-- of the derivation has a trigger: the event window, memberships, tournament
-- brackets, the matches themselves, and lineup membership.

CREATE OR REPLACE FUNCTION public.sync_event_match_links(_event_id uuid)
RETURNS void LANGUAGE sql AS $$
    DELETE FROM public.event_match_links l
     WHERE l.event_id = _event_id
       AND NOT EXISTS (
           SELECT 1 FROM public.v_event_matches v
           WHERE v.event_id = l.event_id AND v.match_id = l.match_id
       );
    INSERT INTO public.event_match_links (event_id, match_id)
    SELECT v.event_id, v.match_id
    FROM public.v_event_matches v
    WHERE v.event_id = _event_id
    ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION public.sync_match_event_links(_match_id uuid)
RETURNS void LANGUAGE sql AS $$
    DELETE FROM public.event_match_links l
     WHERE l.match_id = _match_id
       AND NOT EXISTS (
           SELECT 1 FROM public.v_event_matches v
           WHERE v.event_id = l.event_id AND v.match_id = l.match_id
       );
    INSERT INTO public.event_match_links (event_id, match_id)
    SELECT v.event_id, v.match_id
    FROM public.v_event_matches v
    WHERE v.match_id = _match_id
    ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION public.tg_sync_event_match_links()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.sync_event_match_links(NEW.id);
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_events_sync_match_links ON public.events;
CREATE TRIGGER tg_events_sync_match_links
    AFTER INSERT OR UPDATE OF starts_at, ends_at ON public.events
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links();

CREATE OR REPLACE FUNCTION public.tg_sync_event_match_links_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.sync_event_match_links(COALESCE(NEW.event_id, OLD.event_id));
    RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS tg_event_teams_sync_match_links ON public.event_teams;
CREATE TRIGGER tg_event_teams_sync_match_links
    AFTER INSERT OR DELETE ON public.event_teams
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links_membership();
DROP TRIGGER IF EXISTS tg_event_players_sync_match_links ON public.event_players;
CREATE TRIGGER tg_event_players_sync_match_links
    AFTER INSERT OR DELETE ON public.event_players
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links_membership();
DROP TRIGGER IF EXISTS tg_event_tournaments_sync_match_links ON public.event_tournaments;
CREATE TRIGGER tg_event_tournaments_sync_match_links
    AFTER INSERT OR DELETE ON public.event_tournaments
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links_membership();

CREATE OR REPLACE FUNCTION public.tg_sync_event_match_links_bracket()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    _event uuid;
BEGIN
    FOR _event IN
        SELECT et.event_id
        FROM public.tournament_stages ts
        JOIN public.event_tournaments et ON et.tournament_id = ts.tournament_id
        WHERE ts.id = COALESCE(NEW.tournament_stage_id, OLD.tournament_stage_id)
    LOOP
        PERFORM public.sync_event_match_links(_event);
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS tg_brackets_sync_event_match_links ON public.tournament_brackets;
CREATE TRIGGER tg_brackets_sync_event_match_links
    AFTER INSERT OR UPDATE OF match_id OR DELETE ON public.tournament_brackets
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links_bracket();

CREATE OR REPLACE FUNCTION public.tg_sync_event_match_links_match()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.sync_match_event_links(NEW.id);
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_matches_sync_event_match_links ON public.matches;
CREATE TRIGGER tg_matches_sync_event_match_links
    AFTER INSERT OR UPDATE OF scheduled_at, started_at, lineup_1_id, lineup_2_id
    ON public.matches
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links_match();

-- Player joins/leaves a lineup after the match row exists (player-derived
-- links depend on match_lineup_players).
CREATE OR REPLACE FUNCTION public.tg_sync_event_match_links_mlp()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    _match uuid;
BEGIN
    FOR _match IN
        SELECT m.id FROM public.matches m
        WHERE COALESCE(NEW.match_lineup_id, OLD.match_lineup_id)
              IN (m.lineup_1_id, m.lineup_2_id)
    LOOP
        PERFORM public.sync_match_event_links(_match);
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS tg_mlp_sync_event_match_links ON public.match_lineup_players;
CREATE TRIGGER tg_mlp_sync_event_match_links
    AFTER INSERT OR DELETE ON public.match_lineup_players
    FOR EACH ROW EXECUTE FUNCTION public.tg_sync_event_match_links_mlp();

-- Full backfill/prune. Runs only when this file's digest changes; keeps the
-- table exact after upgrades that alter the derivation.
DELETE FROM public.event_match_links l
 WHERE NOT EXISTS (
     SELECT 1 FROM public.v_event_matches v
     WHERE v.event_id = l.event_id AND v.match_id = l.match_id
 );
INSERT INTO public.event_match_links (event_id, match_id)
SELECT event_id, match_id FROM public.v_event_matches
ON CONFLICT DO NOTHING;
