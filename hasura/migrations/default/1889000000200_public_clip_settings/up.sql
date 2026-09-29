-- The `public.` prefix is the settings ACL: only administrators can read an
-- unprefixed row, so everyone else's clip dialog fell back to 60fps/1080p. A
-- `public.` row that already exists wins over the old one.
UPDATE public.settings
   SET name = 'public.' || name
 WHERE name IN ('clip_fps', 'clip_resolution')
   AND NOT EXISTS (
       SELECT 1
         FROM public.settings existing
        WHERE existing.name = 'public.' || settings.name
   );

DELETE FROM public.settings
 WHERE name IN ('clip_fps', 'clip_resolution');
