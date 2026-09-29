-- The `public.` prefix is the settings ACL: only administrators can read an
-- unprefixed row. The unprefixed row wins a clash, since a `public.` one can
-- only predate this from the new web app saving its form defaults.
INSERT INTO public.settings (name, value)
SELECT 'public.' || name, value
  FROM public.settings
 WHERE name IN ('clip_fps', 'clip_resolution')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

DELETE FROM public.settings
 WHERE name IN ('clip_fps', 'clip_resolution');
