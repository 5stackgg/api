-- The seed once typed Debris and El Dorado as Competitive; Valve ships them for Wingman only.
UPDATE public.maps
SET enabled = false
WHERE type = 'Competitive'
  AND name IN ('de_debris', 'de_eldorado')
  AND active_pool = false;
