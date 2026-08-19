-- How hard a lineup is according to everyone who has ever thrown it, which is
-- a thing only the panel that hosts the practice servers can know.
--
-- A function rather than a stored column: the token is a pure function of
-- three counters already on the row, so a column would be a fourth thing the
-- highest-frequency write in the library has to keep in sync, and a fourth
-- thing that can drift out of it. Nothing sorts on the token either -- the
-- practice plan orders on the landing rate and its own priority, both of
-- which it already has -- so there is nothing here that wanted an index.
--
-- The floors are the point of the whole function. Four attempts by one player
-- is not a hard lineup, it is an unmeasured one, and 'unmeasured' has to be
-- its own answer rather than a rate: any rate computed off that sample is a
-- number the UI renders as if it were knowledge. Two floors rather than one
-- because they fail differently -- one player throwing forty times is one
-- player's aim, and thirty players opening a lineup once each is nobody's.
--
-- Literals rather than settings: this is evaluated per row through a computed
-- field, and a settings lookup per row is a query per row.
CREATE OR REPLACE FUNCTION public.nade_lineup_difficulty(
    lineup public.nade_lineups
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _rate double precision;
BEGIN
    IF COALESCE(lineup.practice_players, 0) < 3
       OR COALESCE(lineup.practice_attempts, 0) < 30 THEN
        RETURN 'unmeasured';
    END IF;

    _rate := lineup.practice_successes::double precision
             / lineup.practice_attempts;

    IF _rate >= 0.7 THEN
        RETURN 'easy';
    END IF;

    IF _rate >= 0.45 THEN
        RETURN 'moderate';
    END IF;

    IF _rate >= 0.2 THEN
        RETURN 'hard';
    END IF;

    RETURN 'very_hard';
END;
$$;
