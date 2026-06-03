-- Canonical CS side token ('t' / 'ct').
--
-- Team strings reach us in several formats depending on the source:
--   * live game plugin  -> "CT" / "TERRORIST" (and historically "T")
--   * demo parser        -> "t" / "ct"
--   * some sources use the raw engine team ids (T = 2, CT = 3)
--
-- Per-side aggregates filtered on a hard-coded 't' / 'ct' therefore silently
-- returned 0 for live matches (only demo / external imports matched). Normalize
-- everything through this helper so the side splits are correct regardless of
-- where the row came from. Returns NULL for anything unrecognized so it simply
-- falls out of both sides rather than corrupting a count.
CREATE OR REPLACE FUNCTION public.normalize_side(p_team text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_team IS NULL THEN NULL
    WHEN lower(p_team) IN ('t', 'terrorist', 'terrorists', '2')        THEN 't'
    WHEN lower(p_team) IN ('ct', 'counterterrorist', 'counterterrorists', '3') THEN 'ct'
    ELSE NULL
  END;
$$;
