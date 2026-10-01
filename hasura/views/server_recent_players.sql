DROP VIEW IF EXISTS public.server_recent_players;

-- One row per player per server across the retained sessions, for the
-- moderator-only Recent Players card. sessions, seconds_played and kills cover
-- only the last seven days, whatever the retention, so the card's "7d" figures
-- mean what they say. No window functions or DISTINCT ON, so a server_id
-- filter is pushed below the GROUP BY onto the sessions index.
CREATE VIEW public.server_recent_players AS
SELECT s.server_id,
       s.player_steam_id,
       (array_agg(s.name ORDER BY s.started_at DESC) FILTER (WHERE s.name IS NOT NULL))[1] AS name,
       (array_agg(host(s.ip) ORDER BY s.started_at DESC) FILTER (WHERE s.ip IS NOT NULL))[1] AS ip,
       (count(*) FILTER (WHERE coalesce(s.ended_at, now()) > now() - interval '7 days'))::int AS sessions,
       coalesce(sum(extract(epoch FROM coalesce(s.ended_at, now())
                                     - greatest(s.started_at, now() - interval '7 days')))
                FILTER (WHERE coalesce(s.ended_at, now()) > now() - interval '7 days'), 0)::int AS seconds_played,
       coalesce(sum(s.kills)
                FILTER (WHERE coalesce(s.ended_at, now()) > now() - interval '7 days'), 0)::int AS kills,
       min(s.started_at) AS first_seen_at,
       max(coalesce(s.ended_at, now())) AS last_seen_at,
       bool_or(s.ended_at IS NULL) AS online
  FROM public.server_player_sessions s
 GROUP BY s.server_id, s.player_steam_id;
