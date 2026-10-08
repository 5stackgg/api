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
        worker_url text;
        version text;
    BEGIN
        IF utility_lineups.preview_file IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(worker_url, '/', utility_lineups.preview_file, '?v=', version);
    END;
$$;

CREATE OR REPLACE FUNCTION public.utility_lineup_preview_thumbnail_url(utility_lineups public.utility_lineups)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
        version text;
    BEGIN
        IF utility_lineups.preview_thumbnail IS NULL THEN
            RETURN NULL;
        END IF;

        version := COALESCE(
            EXTRACT(EPOCH FROM utility_lineups.preview_rendered_at)::bigint::text,
            '0'
        );

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NULL THEN
            RETURN NULL;
        END IF;

        RETURN CONCAT(worker_url, '/', utility_lineups.preview_thumbnail, '?v=', version);
    END;
$$;

-- kind -> url for each still, on the clip's own cache-buster: a re-render
-- writes the same keys.
CREATE OR REPLACE FUNCTION public.utility_lineup_preview_stills_url(utility_lineups public.utility_lineups)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        worker_url text;
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

        SELECT value INTO worker_url
        FROM settings
        WHERE name = 'cloudflare_worker_url';

        IF worker_url IS NULL THEN
            RETURN NULL;
        END IF;

        FOR still IN SELECT key, value FROM jsonb_each_text(utility_lineups.preview_stills) LOOP
            urls := urls || jsonb_build_object(
                still.key,
                CONCAT(worker_url, '/', still.value, '?v=', version)
            );
        END LOOP;

        RETURN urls;
    END;
$$;
