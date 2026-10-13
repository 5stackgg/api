-- 1890000000890 added this column and left the repo with the feature, so only
-- installs that ran it in between still carry it.
ALTER TABLE public.match_options
    DROP COLUMN IF EXISTS map_pool_explicit;
