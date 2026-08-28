-- The named areas of a map -- "Window", "Catwalk", "A Site" -- as CS2 itself
-- defines them in its `env_cs_place` entities. Extracted from the compiled maps
-- by web/scripts/extract-map-callouts.mjs and published beside the collision
-- meshes; a practice plugin reports them for maps the extract does not cover.
--
-- One row per NAME, not per volume: a callout is legitimately several disjoint
-- boxes (Banana is two), and every reader wants "which place is this point in",
-- never "which box".
CREATE TABLE IF NOT EXISTS public.map_callouts (
    map_name text NOT NULL,
    name text NOT NULL,
    -- [{ "min": [x, y, z], "max": [x, y, z] }, ...] in raw CS2 source units,
    -- the same space as demo player positions and the collision meshes.
    boxes jsonb NOT NULL,
    source text NOT NULL DEFAULT 'cdn',
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (map_name, name),
    CONSTRAINT map_callouts_source_check CHECK (source IN ('cdn', 'plugin')),
    CONSTRAINT map_callouts_boxes_check CHECK (jsonb_typeof(boxes) = 'array')
);

-- map_name is stored NORMALISED -- lowercased, any `workshop/<id>/` prefix and
-- `_night` suffix stripped -- so a night variant shares the base map's geometry
-- and its callouts, and every reader looks up the one spelling.
CREATE INDEX IF NOT EXISTS map_callouts_source_idx
    ON public.map_callouts (map_name, source);
