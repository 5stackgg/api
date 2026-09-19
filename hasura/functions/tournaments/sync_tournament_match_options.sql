CREATE OR REPLACE FUNCTION public.sync_tournament_match_options(
    _old public.match_options,
    _new public.match_options
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _assignments text;
    _descendant_ids uuid[];
BEGIN
    -- A descendant follows a column only while it still holds the template's
    -- old value; anything else is a deliberate stage override or a hand-edited
    -- match. best_of is never inherited: schedule_tournament_match resolves it
    -- from the stage's round config.
    SELECT string_agg(
        format(
            '%1$I = CASE WHEN %1$I IS NOT DISTINCT FROM ($1).%1$I THEN ($2).%1$I ELSE %1$I END',
            changed.key
        ),
        ', '
    )
    INTO _assignments
    FROM jsonb_each(to_jsonb(_new)) changed
    WHERE changed.value IS DISTINCT FROM to_jsonb(_old) -> changed.key
      AND changed.key NOT IN ('id', 'invite_code', 'best_of');

    IF _assignments IS NULL THEN
        RETURN;
    END IF;

    SELECT array_agg(descendant.match_options_id)
    INTO _descendant_ids
    FROM (
        SELECT ts.match_options_id
        FROM tournaments t
        INNER JOIN tournament_stages ts ON ts.tournament_id = t.id
        WHERE t.match_options_id = _new.id
          AND ts.match_options_id IS NOT NULL
        UNION
        SELECT m.match_options_id
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN tournaments t ON t.id = ts.tournament_id
        INNER JOIN matches m ON m.id = tb.match_id
        WHERE COALESCE(tb.match_options_id, ts.match_options_id, t.match_options_id) = _new.id
          AND m.status IN ('PickingPlayers', 'Scheduled', 'WaitingForCheckIn')
    ) descendant;

    IF _descendant_ids IS NULL THEN
        RETURN;
    END IF;

    EXECUTE format('UPDATE match_options SET %s WHERE id = ANY($3)', _assignments)
    USING _old, _new, _descendant_ids;
END;
$$;
