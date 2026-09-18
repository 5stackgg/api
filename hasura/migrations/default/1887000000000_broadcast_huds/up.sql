-- The broadcast HUD library.
--
-- Until now the HUD burned into every stream was a closed two-value choice:
-- resolveHudMode() read the `default_hud_mode` setting, stamped HUD_MODE onto
-- the pod, and the spec-server forwarded it as a `?variant=` query param on the
-- ONE bundle JTs Hud Manager ships (`default`). horizontal and vertical were
-- never separate HUDs -- they are two layouts of the same bundle.
--
-- This table adds the dimension that was missing: a hudId. JTs Hud Manager
-- already knows how to hold more than one (`~/jthm-huds`, POST
-- /api/huds/upload-zip, and an /api/overlay/start that has always accepted a
-- hudId the pod never varied). So a row here is "an entry in that library",
-- and the two shipped layouts are seeded as rows so nothing regresses.
CREATE TABLE IF NOT EXISTS public.broadcast_huds (
    id uuid NOT NULL DEFAULT gen_random_uuid(),

    -- Ours: names the row in the panel and the bundle download URL
    -- (/huds/<slug>/bundle.zip). Path-safe because it lands in a URL path.
    slug text NOT NULL,

    -- Theirs: what the pod sends as `hudId` to JTs Hud Manager's
    -- /api/overlay/start. Deliberately NOT the same column as slug -- on import
    -- JTHud derives the id itself (the top-level folder name when hud.json sits
    -- one level deep, otherwise the uploaded filename), so the two can differ
    -- and the panel must remember which one the pod has to ask for.
    jthud_id text NOT NULL,

    -- The `?variant=` appended to that hudId, when the bundle declares layouts
    -- in its hud.json. Carries horizontal/vertical for the two seeded rows;
    -- NULL means "the bundle's own default layout".
    variant text,

    name text NOT NULL,
    author text,
    version text,
    description text,

    -- 'builtin' rows describe what already ships inside the image: they own no
    -- archive and can never be deleted, only disabled. 'imported' rows have a
    -- zip in object storage.
    source text NOT NULL DEFAULT 'imported',

    enabled boolean NOT NULL DEFAULT true,

    -- The whole archive as one object. We deliberately do not extract it:
    -- JTs Hud Manager's own upload-zip endpoint does that inside the pod,
    -- including signature verification, so a second extractor here would only
    -- be a second thing to keep in agreement with it.
    storage_key text,
    size_bytes bigint,

    -- thumb.png/thumb.jpg out of the archive, inlined as a data URL. Small, and
    -- it keeps the library listing from needing a second authenticated fetch per
    -- row just to render a card.
    thumbnail text,

    -- The parsed hud.json, kept whole. Its schema is not publicly specified
    -- beyond name/author/version/thumb, so anything we do not model today is
    -- still here when we learn what it meant.
    hud_json jsonb,

    -- JTHud verifies a signed bundle against the `key` file beside hud.json.
    -- Recorded at import so the library can show it without re-reading the zip.
    is_signed boolean NOT NULL DEFAULT false,

    uploaded_by_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (id),
    UNIQUE (slug),

    -- Same shape the plugin catalog already enforces on game_plugins.slug, and
    -- for the same reason: it is interpolated into a path.
    CONSTRAINT broadcast_huds_slug_is_path_safe
        CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),

    -- jthud_id is what JTHud itself accepts as a directory name; it sanitises to
    -- this set on upload, so anything outside it could never match a real HUD.
    CONSTRAINT broadcast_huds_jthud_id_is_path_safe
        CHECK (jthud_id ~ '^[A-Za-z0-9_-]+$'),

    CONSTRAINT broadcast_huds_source_is_known
        CHECK (source IN ('builtin', 'imported')),

    -- A builtin has nothing to download and an import is useless without it.
    CONSTRAINT broadcast_huds_archive_matches_source
        CHECK (
            (source = 'builtin'  AND storage_key IS NULL)
         OR (source = 'imported' AND storage_key IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_broadcast_huds_enabled
    ON public.broadcast_huds (enabled);

-- Exactly the two layouts the image ships today, as rows. Seeding them is what
-- lets the pickers become "list the library" instead of "list a hardcoded
-- union", without the two familiar options disappearing from the UI.
--
-- ON CONFLICT DO NOTHING rather than an upsert: an operator who renamed or
-- disabled one of these meant it, and this file is re-applied on every boot.
INSERT INTO public.broadcast_huds
    (slug, jthud_id, variant, name, description, source)
VALUES
    ('default-horizontal', 'default', 'horizontal',
     'JTs Hud (Horizontal)',
     'The layout bundled with JTs Hud Manager, arranged horizontally.',
     'builtin'),
    ('default-vertical', 'default', 'vertical',
     'JTs Hud (Vertical)',
     'The layout bundled with JTs Hud Manager, arranged vertically.',
     'builtin')
ON CONFLICT (slug) DO NOTHING;
