-- The `public.` row wins a clash: it is the value the api applied since 1889000000300.
INSERT INTO public.settings (name, value)
SELECT substring(name FROM length('public.') + 1), value
  FROM public.settings
 WHERE name IN ('public.clip_fps', 'public.clip_resolution')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

DELETE FROM public.settings
 WHERE name IN ('public.clip_fps', 'public.clip_resolution');
