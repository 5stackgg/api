-- Season numbers are derived, not assigned: seasons are renumbered 1..N by
-- ascending start date whenever the set changes. Idempotent (only rows whose
-- number is wrong are touched). NOT depth-guarded: the internal UPDATE only
-- touches `number`, which no trigger watches, so it can't recurse — and running
-- while nested is required so an auto-created season (inserted from inside another
-- trigger) still gets renumbered.
CREATE OR REPLACE FUNCTION public.recompute_season_numbers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY starts_at ASC) AS rn
        FROM seasons
    )
    UPDATE seasons s
    SET number = r.rn
    FROM ranked r
    WHERE s.id = r.id
      AND s.number IS DISTINCT FROM r.rn;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS recompute_season_numbers ON public.seasons;
CREATE TRIGGER recompute_season_numbers
AFTER INSERT OR DELETE OR UPDATE OF starts_at ON public.seasons
FOR EACH STATEMENT EXECUTE FUNCTION public.recompute_season_numbers();

-- BEFORE INSERT/UPDATE: assign a non-null number (so `number` is never null even
-- for auto-created rows) and flag a rebuild whenever the season's match membership
-- could have changed. The backfill clears needs_rebuild once it recomputes.
CREATE OR REPLACE FUNCTION public.tbi_seasons_mark_rebuild()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Position by start date; the statement-level recompute keeps the whole
        -- set consistent afterward.
        NEW.number := (
            SELECT COUNT(*) FROM seasons WHERE starts_at < NEW.starts_at
        ) + 1;
        -- Only flag a rebuild if the season actually covers recorded matches.
        NEW.needs_rebuild := EXISTS (
            SELECT 1 FROM matches m
            WHERE m.source = '5stack'
              AND m.ended_at IS NOT NULL
              AND m.ended_at >= NEW.starts_at
              AND (NEW.ends_at IS NULL OR m.ended_at < NEW.ends_at)
              AND NOT EXISTS (
                  SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id
              )
        );
    ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
        -- Moving the start almost always changes membership.
        NEW.needs_rebuild := true;
    ELSIF NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
        -- OR with the existing flag so a pending rebuild is never cleared by an end
        -- change (only the backfill clears it). Ending "now"/future excludes nothing
        -- and adds no flag; ending in the past or extending over existing matches does.
        NEW.needs_rebuild := OLD.needs_rebuild
            OR EXISTS (
                SELECT 1 FROM player_elo pe
                WHERE pe.season_id = NEW.id
                  AND pe.created_at >= NEW.ends_at
            )
            OR EXISTS (
                SELECT 1 FROM matches m
                WHERE m.source = '5stack'
                  AND m.ended_at >= COALESCE(OLD.ends_at, NEW.ends_at)
                  AND m.ended_at < NEW.ends_at
                  AND NOT EXISTS (
                      SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id
                  )
            );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_seasons_mark_rebuild ON public.seasons;
CREATE TRIGGER tbi_seasons_mark_rebuild
BEFORE INSERT OR UPDATE ON public.seasons
FOR EACH ROW EXECUTE FUNCTION public.tbi_seasons_mark_rebuild();

-- Ending a (latest) season auto-starts the next one at exactly that end time, so
-- play is never left off-season and the chain stays contiguous with no overlap.
-- Depth-guarded so the auto-created row can't cascade. Overlap is otherwise
-- prevented by the seasons_no_overlap exclusion constraint.
CREATE OR REPLACE FUNCTION public.tai_seasons_reconcile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    IF NEW.ends_at IS NOT NULL
       AND OLD.ends_at IS DISTINCT FROM NEW.ends_at
       AND NOT EXISTS (
           SELECT 1 FROM seasons WHERE id <> NEW.id AND starts_at >= NEW.ends_at
       ) THEN
        INSERT INTO seasons (starts_at, ends_at, description)
        VALUES (NEW.ends_at, NULL, NULL);
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_seasons_reconcile ON public.seasons;
CREATE TRIGGER tai_seasons_reconcile
AFTER UPDATE OF starts_at, ends_at ON public.seasons
FOR EACH ROW EXECUTE FUNCTION public.tai_seasons_reconcile();
