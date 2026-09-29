UPDATE public.settings
   SET name = substring(name FROM length('public.') + 1)
 WHERE name IN ('public.clip_fps', 'public.clip_resolution')
   AND NOT EXISTS (
       SELECT 1
         FROM public.settings existing
        WHERE existing.name = substring(settings.name FROM length('public.') + 1)
   );

DELETE FROM public.settings
 WHERE name IN ('public.clip_fps', 'public.clip_resolution');
