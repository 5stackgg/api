CREATE OR REPLACE FUNCTION public.get_draft_game_pattern(dg public.draft_games) RETURNS int[]
    LANGUAGE plpgsql STABLE
AS $$
DECLARE
    picks int;
    per_team_picks int;
    pattern int[] := '{}';
    raw int;
    c1 int := 0;
    c2 int := 0;
    i int;
BEGIN
    picks := dg.capacity - 2;
    per_team_picks := dg.capacity / 2 - 1;

    IF picks <= 0 THEN
        RETURN pattern;
    END IF;

    FOR i IN 0..(picks - 1) LOOP
        IF dg.draft_order = 'Alternating' THEN
            raw := CASE WHEN i % 2 = 0 THEN 1 ELSE 2 END;
        ELSIF dg.draft_order = 'FrontLoaded' THEN
            -- 1,2,2,1,2,1,2,1...: team 2 doubles up early, then alternates
            IF i = 0 THEN
                raw := 1;
            ELSIF i = 1 OR i = 2 THEN
                raw := 2;
            ELSE
                raw := CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END;
            END IF;
        ELSE
            -- 1,2,2,1,1,2,2,1...: snake reverses each round
            IF (i / 2) % 2 = 0 THEN
                raw := CASE WHEN i % 2 = 0 THEN 1 ELSE 2 END;
            ELSE
                raw := CASE WHEN i % 2 = 0 THEN 2 ELSE 1 END;
            END IF;
        END IF;

        IF raw = 1 AND c1 >= per_team_picks THEN
            raw := 2;
        ELSIF raw = 2 AND c2 >= per_team_picks THEN
            raw := 1;
        END IF;

        IF raw = 1 THEN
            c1 := c1 + 1;
        ELSE
            c2 := c2 + 1;
        END IF;

        pattern := array_append(pattern, raw);
    END LOOP;

    RETURN pattern;
END;
$$;
