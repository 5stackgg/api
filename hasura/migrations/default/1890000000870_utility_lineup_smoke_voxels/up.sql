-- The smoke the game itself simulated for a lineup, rebuilt by the parser from
-- the voxel log the practice plugin recorded: the S3 key of that row, and when
-- it was recorded. A render re-records it, so the key changes with each one.
ALTER TABLE public.utility_lineups
    ADD COLUMN IF NOT EXISTS smoke_voxels_file text,
    ADD COLUMN IF NOT EXISTS smoke_voxels_at timestamptz;
