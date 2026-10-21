-- A workshop map turned on for another mode never copied its label, and a
-- mode that is locked can't be toggled to repair the copy. Each copy without a
-- label takes the one its Competitive copy has, or else another mode's.
UPDATE public.maps m
   SET label = src.label
  FROM (
      SELECT DISTINCT ON (name) name, label
        FROM public.maps
       WHERE label <> ''
         AND deleted_at IS NULL
       ORDER BY name, (type = 'Competitive') DESC, type
  ) src
 WHERE m.name = src.name
   AND m.label IS NULL;
