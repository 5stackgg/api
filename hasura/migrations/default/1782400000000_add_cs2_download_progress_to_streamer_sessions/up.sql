-- Adds CS2 download progress fields populated by the game-streamer pod
-- while steamcmd runs. Both columns are nullable; null means "not
-- currently downloading" so the API can null them out when the next
-- status (e.g. launching_cs2) arrives without progress fields and the
-- UI's progress bar disappears in the same subscription tick that flips
-- the badge.
--
-- Scale is 0..100 to match steamcmd's own format and game_server_nodes
-- update_status — note clip_render_jobs.progress is 0..1; intentional
-- divergence (no shared UI components).

alter table "public"."match_streams"
  add column "progress" numeric(5, 2),
  add column "progress_stage" text,
  add constraint match_streams_progress_chk
    check (progress is null or (progress >= 0 and progress <= 100));

alter table "public"."match_demo_sessions"
  add column "progress" numeric(5, 2),
  add column "progress_stage" text,
  add constraint match_demo_sessions_progress_chk
    check (progress is null or (progress >= 0 and progress <= 100));
