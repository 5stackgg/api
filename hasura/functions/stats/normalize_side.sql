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
