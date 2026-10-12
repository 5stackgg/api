ALTER TABLE public.utility_lineups
    DROP COLUMN IF EXISTS smoke_voxels_at,
    DROP COLUMN IF EXISTS smoke_voxels_file;
