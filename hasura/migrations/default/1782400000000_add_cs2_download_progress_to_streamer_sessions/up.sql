-- CS2 download progress fed by the game-streamer pod parsing steamcmd
-- output. Null means "not currently downloading". Scale is 0..100.

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
