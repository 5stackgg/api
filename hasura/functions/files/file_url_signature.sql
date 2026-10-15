-- The query string the Cloudflare worker, and the api on the demos domain,
-- require before serving a file under clips/: `exp` and an HMAC over
-- "<key>\n<exp>" (FileUrlSigningService.verify). Only the computed fields call
-- this, so a link is minted only for a row the viewer may read.
--
-- exp is the end of the bucket after the current one: a link stays the same for
-- a whole bucket, so it caches and a subscription does not push a new one, and
-- it always has at least a bucket left to run. A public file's bucket is a year,
-- so a link already embedded on Discord or Twitter keeps working; anything else
-- gets six hours.
--
-- NULL until the api has stored the key, and the callers then hand the link out
-- unsigned rather than not at all: these functions are applied by hasura's
-- migrations container, which cannot derive the key, so a rollout reaches them
-- before the api can sign. An unsigned link opens nothing where signatures are
-- required.
--
-- plpgsql, not sql: a sql function reading a table cannot be inlined, so every
-- row of a clip or lineup page would start its own executor, while plpgsql
-- keeps the key lookup's plan for the session.
CREATE OR REPLACE FUNCTION public.file_url_signature(file_key text, public_file boolean)
    RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
        signing_key bytea;
        bucket_seconds bigint;
        expiry bigint;
    BEGIN
        IF file_key IS NULL THEN
            RETURN NULL;
        END IF;

        SELECT key INTO signing_key FROM private.file_url_signing_key;

        IF signing_key IS NULL THEN
            RETURN NULL;
        END IF;

        bucket_seconds := CASE WHEN public_file THEN 31536000 ELSE 21600 END;
        expiry := (floor(extract(epoch FROM now()) / bucket_seconds)::bigint + 2) * bucket_seconds;

        RETURN 'exp=' || expiry || '&sig=' || rtrim(translate(encode(
            hmac(convert_to(file_key || E'\n' || expiry, 'UTF8'), signing_key, 'sha256'),
            'base64'
        ), '+/', '-_'), '=');
    END;
$$;
