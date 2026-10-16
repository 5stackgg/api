UPDATE public.maps
SET enabled = true
WHERE type = 'Competitive'
  AND name IN ('de_debris', 'de_eldorado');
