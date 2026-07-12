-- The canonical "matches of an event" set, shared by the event page match
-- list (Hasura-tracked), get_event_leaderboard and v_event_player_stats so
-- the three can never disagree.
--
-- A match belongs to an event when any of:
--   - it sits in a bracket of an attached tournament (no time window: the
--     tournament was explicitly attached, its matches are the event's);
--   - one of its lineups is an attached team and the match falls inside the
--     event window;
--   - one of its lineup players is an attached player and the match falls
--     inside the event window.
--
-- The window is [starts_at, end + 1 day):
--   - window_start is the event's starts_at. An event with NO start date is
--     excluded from the windowed (team/player) branches entirely — otherwise
--     a missing start defaulted to -infinity and pulled in an attached team's
--     or player's ENTIRE match history (lifetime stats/highlights instead of
--     just this event's). Dateless events still get their attached
--     tournaments' bracket matches (that branch needs no window).
--   - window_end is ends_at + 1 day, or, for an ongoing event with no end
--     date, now() + 1 day so every match played up to today is captured. The
--     day of grace lets matches that start on the final evening still count
--     when ends_at is set to midday.
-- event_match_links materializes this view via triggers; a match completed
-- while an event is ongoing is re-derived on its started_at update (see
-- hasura/triggers/event_match_links.sql), so now() here stays accurate.
CREATE OR REPLACE VIEW public.v_event_matches AS
WITH windowed AS (
    SELECT
        e.id AS event_id,
        e.starts_at AS window_start,
        COALESCE(e.ends_at, now()) + interval '1 day' AS window_end
    FROM events e
    WHERE e.starts_at IS NOT NULL
)
SELECT DISTINCT s.event_id, s.match_id
FROM (
    SELECT et.event_id, tb.match_id
    FROM event_tournaments et
    JOIN tournament_stages ts ON ts.tournament_id = et.tournament_id
    JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
    WHERE tb.match_id IS NOT NULL

    UNION ALL

    SELECT w.event_id, m.id AS match_id
    FROM windowed w
    JOIN event_teams et ON et.event_id = w.event_id
    JOIN match_lineups ml ON ml.team_id = et.team_id
    JOIN matches m ON ml.id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE COALESCE(m.started_at, m.scheduled_at, m.created_at) >= w.window_start
      AND COALESCE(m.started_at, m.scheduled_at, m.created_at) < w.window_end

    UNION ALL

    SELECT w.event_id, m.id AS match_id
    FROM windowed w
    JOIN event_players ep ON ep.event_id = w.event_id
    JOIN match_lineup_players mlp ON mlp.steam_id = ep.steam_id
    JOIN matches m ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE COALESCE(m.started_at, m.scheduled_at, m.created_at) >= w.window_start
      AND COALESCE(m.started_at, m.scheduled_at, m.created_at) < w.window_end
) s;
