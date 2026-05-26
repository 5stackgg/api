alter table "public"."clip_render_jobs"
  add column if not exists "paused" boolean not null default false;

create index if not exists "clip_render_jobs_paused_in_flight_idx"
  on "public"."clip_render_jobs" ("match_map_id", "match_map_demo_id")
  where "paused" and "status" = 'queued';
