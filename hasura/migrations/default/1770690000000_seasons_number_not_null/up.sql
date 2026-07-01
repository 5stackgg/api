-- Season number is derived and must never be null. Backfill any gaps (e.g. an
-- auto-created season that missed renumbering), then enforce NOT NULL.
WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY starts_at ASC) AS rn
    FROM public.seasons
)
UPDATE public.seasons s
SET number = r.rn
FROM ranked r
WHERE s.id = r.id
  AND s.number IS DISTINCT FROM r.rn;

ALTER TABLE public.seasons ALTER COLUMN number SET NOT NULL;
