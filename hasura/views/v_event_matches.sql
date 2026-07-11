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
-- The window end gets a day of grace so matches that start on the final
-- evening still count when ends_at is set to midday; missing dates leave
-- that side of the window open.
CREATE OR REPLACE VIEW public.v_event_matches AS
WITH windowed AS (
    SELECT
        e.id AS event_id,
        COALESCE(e.starts_at, '-infinity'::timestamptz) AS window_start,
        COALESCE(e.ends_at + interval '1 day', 'infinity'::timestamptz) AS window_end
    FROM events e
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
