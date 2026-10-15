-- Whether a player's own setting for a room lets a message in it push them.
-- "nothing" lets nothing through, a tag breaks through everything else, and
-- otherwise only a room left on "all" that is not muted right now. A timed
-- mute is compared against now(), so it stops applying the moment it runs
-- out and nothing has to clear it.
CREATE OR REPLACE FUNCTION public.chat_room_notifies(
    _steam_id bigint,
    _thread text,
    _mention boolean
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((
        SELECT CASE
                 WHEN s.notify = 'nothing' THEN false
                 WHEN _mention THEN true
                 WHEN s.notify = 'mentions' THEN false
                 ELSE NOT (s.muted
                           AND (s.muted_until IS NULL OR s.muted_until > now()))
               END
          FROM public.chat_room_settings s
         WHERE s.steam_id = _steam_id
           AND s.thread = _thread
    ), true);
$$;
