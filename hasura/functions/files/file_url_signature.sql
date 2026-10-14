-- The query string the Cloudflare worker, and the api on the demos domain,
-- require before serving a file under clips/: `exp` and an HMAC over
-- "<key>\n<exp>" (FileUrlSigningService.verify). Only the computed fields call
-- this, so a link is minted only for a row the viewer may read.
--
-- exp is the end of the bucket after the current one: a link stays the same for
-- a whole bucket, so it caches and a subscription does not push a new one, and
-- it always has at least a bucket left to run.
--
-- NULL until the api has stored the key, and the callers then hand the link out
-- unsigned rather than not at all: these functions are applied by hasura's
-- migrations container, which cannot derive the key, so a rollout reaches them
-- before the api can sign. An unsigned link opens nothing where signatures are
-- required.
CREATE OR REPLACE FUNCTION public.file_url_signature(file_key text, public_file boolean)
    RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT CONCAT(
        'exp=', expiry.exp,
        '&sig=', rtrim(translate(encode(
            hmac(convert_to(file_key || E'\n' || expiry.exp, 'UTF8'), signing.key, 'sha256'),
            'base64'
        ), '+/', '-_'), '=')
    )
    FROM private.file_url_signing_key signing,
         LATERAL (
             SELECT (floor(extract(epoch FROM now()) / bucket.seconds)::bigint + 2) * bucket.seconds AS exp
             FROM (SELECT CASE WHEN public_file THEN 604800 ELSE 21600 END::bigint AS seconds) bucket
         ) expiry
    WHERE file_key IS NOT NULL;
$$;
