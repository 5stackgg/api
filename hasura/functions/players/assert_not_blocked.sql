-- One code for both directions: whoever hits it must not learn which of the two
-- did the blocking, so the message never names a side.
CREATE OR REPLACE FUNCTION public.assert_not_blocked(a bigint, b bigint)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF public.is_blocked_either_way(a, b) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'player_blocked';
    END IF;
END;
$$;
