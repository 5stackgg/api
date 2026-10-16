-- Whether hasura/enums/maps.sql ships the map. Every instance seeds the same
-- maps, and their map assets are built once on 5stack.gg for all of them, so a
-- seeded map is built whatever this instance's own modes enable.
ALTER TABLE public.maps ADD COLUMN IF NOT EXISTS seeded boolean NOT NULL DEFAULT false;
