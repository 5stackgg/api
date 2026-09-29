INSERT INTO public.settings (name, value)
SELECT 'public.' || name, value
  FROM public.settings
 WHERE name IN ('clip_fps', 'clip_resolution')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

DELETE FROM public.settings
 WHERE name IN ('clip_fps', 'clip_resolution');
