-- A practice server runs the practice plugin, which can never be loaded
-- alongside the match plugin. Every matchmaking query already filters
-- type = 'Ranked', so a distinct type is what keeps the two pools apart.
INSERT INTO public.e_server_types ("value", "description") VALUES
    ('Practice', '5Stack Practice Server')
ON CONFLICT(value) DO UPDATE SET "description" = EXCLUDED."description";
