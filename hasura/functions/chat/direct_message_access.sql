-- An accepted friendship, in either direction.
CREATE OR REPLACE FUNCTION public.are_friends(a bigint, b bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.friends f
         WHERE f.status = 'Accepted'
           AND ((f.player_steam_id = a AND f.other_player_steam_id = b)
             OR (f.player_steam_id = b AND f.other_player_steam_id = a))
    );
$$;

-- Whether a party may open a direct room: friends, a conversation that already
-- exists, or someone who takes message requests. plpgsql so the body is not
-- resolved at create time -- is_blocked_either_way is applied after this file.
CREATE OR REPLACE FUNCTION public.can_view_direct_room(_room_id text, _viewer bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _a bigint := split_part(_room_id, ':', 1)::bigint;
    _b bigint := split_part(_room_id, ':', 2)::bigint;
    _other bigint := CASE WHEN _a = _viewer THEN _b ELSE _a END;
BEGIN
    IF public.is_blocked_either_way(_viewer, _other) THEN
        RETURN false;
    END IF;

    RETURN public.are_friends(_viewer, _other)
        OR EXISTS (SELECT 1 FROM public.direct_conversations dc
                    WHERE dc.room_id = _room_id)
        OR EXISTS (SELECT 1 FROM public.players p
                    WHERE p.steam_id = _other
                      AND p.allow_message_requests);
END;
$$;

-- Why _from may not send in _room_id right now, or NULL when they may:
--   blocked        -- either side blocked the other
--   awaiting_reply -- their one request is out and has not been answered
--   requests_off   -- the other side only takes messages from friends
-- Friends always may. So may either side of an accepted conversation, and the
-- recipient of a request, whose reply is what accepts it.
CREATE OR REPLACE FUNCTION public.direct_message_refusal(_room_id text, _from bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _a bigint := split_part(_room_id, ':', 1)::bigint;
    _b bigint := split_part(_room_id, ':', 2)::bigint;
    _to bigint := CASE WHEN _a = _from THEN _b ELSE _a END;
BEGIN
    IF public.is_blocked_either_way(_from, _to) THEN
        RETURN 'blocked';
    END IF;

    IF public.are_friends(_from, _to) THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM public.direct_conversations dc
                WHERE dc.room_id = _room_id
                  AND dc.steam_id = _to
                  AND dc.accepted_at IS NOT NULL
                  AND dc.declined_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.direct_messages dm
                   WHERE dm.room_id = _room_id
                     AND dm.from_steam_id = _to) THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM public.direct_messages dm
                WHERE dm.room_id = _room_id
                  AND dm.from_steam_id = _from) THEN
        RETURN 'awaiting_reply';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.players p
                    WHERE p.steam_id = _to
                      AND p.allow_message_requests) THEN
        RETURN 'requests_off';
    END IF;

    RETURN NULL;
END;
$$;
