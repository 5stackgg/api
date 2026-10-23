-- Share codes were decoded in base 58 with a "g" that Valve's alphabet does not
-- have, so every Valve import stored a match id that isn't Valve's. Only ids
-- that decoder wrote are recomputed. An id another row already holds is left
-- as it was, since both are then the same Valve match.
CREATE FUNCTION pg_temp.share_code_match_id(share_code text, alphabet text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    body text := replace(regexp_replace(share_code, '^CSGO-', '', 'i'), '-', '');
    value numeric := 0;
    digit int;
    bytes int[] := '{}';
    match_id numeric := 0;
BEGIN
    IF length(body) <> 25 THEN
        RETURN NULL;
    END IF;

    FOR i IN REVERSE 25..1 LOOP
        digit := strpos(alphabet, substr(body, i, 1)) - 1;
        IF digit < 0 THEN
            RETURN NULL;
        END IF;
        value := value * length(alphabet) + digit;
    END LOOP;

    -- 18 bytes big-endian; the match id is the first 8 read little-endian.
    FOR i IN 1..18 LOOP
        bytes := mod(value, 256)::int || bytes;
        value := div(value, 256);
    END LOOP;

    FOR i IN REVERSE 8..1 LOOP
        match_id := match_id * 256 + bytes[i];
    END LOOP;

    RETURN match_id;
END;
$$;

CREATE TEMPORARY TABLE share_code_match_ids ON COMMIT DROP AS
SELECT share_code,
       pg_temp.share_code_match_id(share_code, 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789') AS valve_match_id,
       pg_temp.share_code_match_id(share_code, 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') AS old_match_id
  FROM (
      SELECT share_code FROM public.matches
       WHERE source = 'valve' AND share_code IS NOT NULL
      UNION
      SELECT share_code FROM public.pending_match_imports
  ) codes;

WITH claimed AS (
    SELECT DISTINCT ON (ids.valve_match_id) p.valve_match_id AS old_match_id, ids.valve_match_id
      FROM public.pending_match_imports p
      JOIN share_code_match_ids ids ON ids.share_code = p.share_code
     WHERE p.valve_match_id = ids.old_match_id
       AND ids.valve_match_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.pending_match_imports taken
            WHERE taken.valve_match_id = ids.valve_match_id
       )
     ORDER BY ids.valve_match_id, p.created_at
)
UPDATE public.pending_match_imports p
   SET valve_match_id = claimed.valve_match_id
  FROM claimed
 WHERE p.valve_match_id = claimed.old_match_id;

WITH claimed AS (
    SELECT DISTINCT ON (ids.valve_match_id) m.id, ids.valve_match_id::text AS external_id
      FROM public.matches m
      JOIN share_code_match_ids ids ON ids.share_code = m.share_code
     WHERE m.source = 'valve'
       AND m.external_id = ids.old_match_id::text
       AND ids.valve_match_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.matches taken
            WHERE taken.source = 'valve'
              AND taken.external_id = ids.valve_match_id::text
       )
     ORDER BY ids.valve_match_id, m.created_at, m.id
)
UPDATE public.matches m
   SET external_id = claimed.external_id
  FROM claimed
 WHERE m.id = claimed.id;

DROP FUNCTION pg_temp.share_code_match_id(text, text);
