-- is_banned, is_gagged and is_muted are read for every player on every poll
-- but only change when a sanction is added, edited or lifted, or runs out. Each
-- player keeps when their ban, gag and mute end: -infinity for none, infinity
-- for one with no end date. The checks compare those with now()
-- (hasura/functions/players/is_baned.sql), and
-- hasura/triggers/player_sanctions.sql keeps them current.
ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS ban_ends_at timestamptz NOT NULL DEFAULT '-infinity',
    ADD COLUMN IF NOT EXISTS gag_ends_at timestamptz NOT NULL DEFAULT '-infinity',
    ADD COLUMN IF NOT EXISTS mute_ends_at timestamptz NOT NULL DEFAULT '-infinity';

UPDATE public.players p
SET ban_ends_at = s.ban_ends_at,
    gag_ends_at = s.gag_ends_at,
    mute_ends_at = s.mute_ends_at
FROM (
    SELECT player_steam_id,
           COALESCE(MAX(COALESCE(remove_sanction_date, 'infinity')) FILTER (WHERE type = 'ban'), '-infinity') AS ban_ends_at,
           COALESCE(MAX(COALESCE(remove_sanction_date, 'infinity')) FILTER (WHERE type IN ('gag', 'silence')), '-infinity') AS gag_ends_at,
           COALESCE(MAX(COALESCE(remove_sanction_date, 'infinity')) FILTER (WHERE type IN ('mute', 'silence')), '-infinity') AS mute_ends_at
    FROM public.player_sanctions
    WHERE deleted_at IS NULL
    GROUP BY player_steam_id
) s
WHERE p.steam_id = s.player_steam_id;
