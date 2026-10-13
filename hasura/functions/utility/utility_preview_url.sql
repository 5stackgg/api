-- Where a lineup's stored files are fetched from. A panel without a Cloudflare
-- worker has no cloudflare_worker_url, and the API serves the same key at the
-- same path on the demos domain instead (ClipDownloadController), as it does a
-- highlight (clip_download_url). It checks there who is asking, so a lineup
-- that is not public still has a url: one only its viewers can fetch.
DROP FUNCTION IF EXISTS public.utility_lineup_file_base_url(public.utility_lineups);
CREATE OR REPLACE FUNCTION public.utility_lineup_file_base_url()
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(
        (SELECT value FROM settings WHERE name = 'cloudflare_worker_url'),
        (SELECT value FROM settings WHERE name = 'demos_domain')
    );
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
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        base_url text;
        version text;
    BEGIN
        IF utility_lineups.preview_file IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        base_url := public.utility_lineup_file_base_url();

        IF base_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(base_url, '/', utility_lineups.preview_file, '?v=', version);
    END;
$$;

CREATE OR REPLACE FUNCTION public.utility_lineup_preview_thumbnail_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        base_url text;
        version text;
    BEGIN
        IF utility_lineups.preview_thumbnail IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        base_url := public.utility_lineup_file_base_url();

        IF base_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(base_url, '/', utility_lineups.preview_thumbnail, '?v=', version);
    END;
$$;

-- kind -> url for each still, on the clip's own cache-buster: a re-render
-- writes the same keys.
CREATE OR REPLACE FUNCTION public.utility_lineup_preview_stills_url(utility_lineups public.utility_lineups)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        base_url text;
        version text;
        still record;
        urls jsonb := '{}'::jsonb;
    BEGIN
        IF utility_lineups.preview_stills IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        base_url := public.utility_lineup_file_base_url();

        IF base_url IS NULL THEN
            RETURN NULL;
        END IF;

        FOR still IN SELECT key, value FROM jsonb_each_text(utility_lineups.preview_stills) LOOP
            urls := urls || jsonb_build_object(
                still.key,
                CONCAT(base_url, '/', still.value, '?v=', version)
            );
        END LOOP;

        RETURN urls;
    END;
$$;

-- The recorded smoke, from the same worker as the clip for the same reason.
-- smoke_voxels_at busts the browser's copy; the key itself changes with every
-- recording, which is what gets past the worker's.
CREATE OR REPLACE FUNCTION public.utility_lineup_smoke_voxels_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        base_url text;
        version text;
    BEGIN
        IF utility_lineups.smoke_voxels_file IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.smoke_voxels_at)::bigint::text,
            '0'
        );

        base_url := public.utility_lineup_file_base_url();

        IF base_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(base_url, '/', utility_lineups.smoke_voxels_file, '?v=', version);
    END;
$$;
