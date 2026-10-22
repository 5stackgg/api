-- Where a lineup's stored files are fetched from. A panel without a Cloudflare
-- worker has no cloudflare_worker_url, and the API serves the same key at the
-- same path on the demos domain instead (ClipDownloadController), as it does a
-- highlight (clip_download_url). Both serve a key under clips/ only on a link
-- signed here (file_url_signature); the API also takes the session of someone
-- who may see the lineup.
--
-- plpgsql for the same reason as file_url_signature: it runs for every file of
-- every lineup on a page.
DROP FUNCTION IF EXISTS public.utility_lineup_file_base_url(public.utility_lineups);
CREATE OR REPLACE FUNCTION public.utility_lineup_file_base_url()
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        base_url text;
    BEGIN
        SELECT value INTO base_url FROM settings WHERE name = 'cloudflare_worker_url';

        IF base_url IS NULL THEN
            SELECT value INTO base_url FROM settings WHERE name = 'demos_domain';
        END IF;

        RETURN base_url;
    END;
$$;

-- A lineup anyone may see gets the long-lived link a shared card needs. Takes
-- the columns rather than the row, for the reason given in utility_access.sql.
DROP FUNCTION IF EXISTS public.utility_lineup_file_url(public.utility_lineups, text, text);
CREATE OR REPLACE FUNCTION public._utility_lineup_file_url(
    file_key text,
    version text,
    _archived_at timestamptz,
    _author_steam_id bigint,
    _visibility text,
    _team_id uuid
)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        base_url text;
        signature text;
    BEGIN
        base_url := public.utility_lineup_file_base_url();
        signature := public.file_url_signature(
            file_key,
            public._can_view_utility_lineup(
                _archived_at, _author_steam_id, _visibility, _team_id, '{}'::json
            ) IS TRUE
        );

        IF base_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(base_url, '/', file_key, '?v=', version, '&' || signature);
    END;
$$;

CREATE OR REPLACE FUNCTION public._utility_lineup_versioned_file_url(
    file_key text,
    version_at timestamptz,
    _archived_at timestamptz,
    _author_steam_id bigint,
    _visibility text,
    _team_id uuid
)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    BEGIN
        IF file_key IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN public._utility_lineup_file_url(
            file_key,
            COALESCE(EXTRACT(EPOCH FROM version_at)::bigint::text, '0'),
            _archived_at,
            _author_steam_id,
            _visibility,
            _team_id
        );
    END;
$$;

-- The preview clip is served by the same Cloudflare worker as a highlight, so
-- its key lives under clips/ -- that prefix is the only one the worker's route
-- patterns match, and a new prefix would need a worker redeploy to be reachable
-- at all.
--
-- The cache-buster is preview_rendered_at, not created_at: a re-render writes
-- the same key, and the worker caches immutably for 30 days.
CREATE OR REPLACE FUNCTION public.utility_lineup_preview_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT public._utility_lineup_versioned_file_url(
        utility_lineups.preview_file,
        utility_lineups.preview_rendered_at,
        utility_lineups.archived_at,
        utility_lineups.author_steam_id,
        utility_lineups.visibility,
        utility_lineups.team_id
    );
$$;

CREATE OR REPLACE FUNCTION public.utility_lineup_preview_thumbnail_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT public._utility_lineup_versioned_file_url(
        utility_lineups.preview_thumbnail,
        utility_lineups.preview_rendered_at,
        utility_lineups.archived_at,
        utility_lineups.author_steam_id,
        utility_lineups.visibility,
        utility_lineups.team_id
    );
$$;

-- kind -> url for each still, on the clip's own cache-buster: a re-render
-- writes the same keys.
CREATE OR REPLACE FUNCTION public._utility_lineup_preview_stills_url(
    _preview_stills jsonb,
    _preview_rendered_at timestamptz,
    _archived_at timestamptz,
    _author_steam_id bigint,
    _visibility text,
    _team_id uuid
)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        version text;
        still record;
        url text;
        urls jsonb := '{}'::jsonb;
    BEGIN
        IF _preview_stills IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM _preview_rendered_at)::bigint::text,
            '0'
        );

        FOR still IN SELECT key, value FROM jsonb_each_text(_preview_stills) LOOP
            url := public._utility_lineup_file_url(
                still.value, version, _archived_at, _author_steam_id, _visibility, _team_id
            );

            IF url IS NULL THEN
                RETURN NULL;
            END IF;

            urls := urls || jsonb_build_object(still.key, url);
        END LOOP;

        RETURN urls;
    END;
$$;

CREATE OR REPLACE FUNCTION public.utility_lineup_preview_stills_url(utility_lineups public.utility_lineups)
    RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
    SELECT public._utility_lineup_preview_stills_url(
        utility_lineups.preview_stills,
        utility_lineups.preview_rendered_at,
        utility_lineups.archived_at,
        utility_lineups.author_steam_id,
        utility_lineups.visibility,
        utility_lineups.team_id
    );
$$;

-- The recorded smoke, from the same worker as the clip for the same reason.
-- smoke_voxels_at busts the browser's copy; the key itself changes with every
-- recording, which is what gets past the worker's.
CREATE OR REPLACE FUNCTION public.utility_lineup_smoke_voxels_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT public._utility_lineup_versioned_file_url(
        utility_lineups.smoke_voxels_file,
        utility_lineups.smoke_voxels_at,
        utility_lineups.archived_at,
        utility_lineups.author_steam_id,
        utility_lineups.visibility,
        utility_lineups.team_id
    );
$$;
