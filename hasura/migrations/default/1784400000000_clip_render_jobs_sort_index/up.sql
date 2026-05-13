alter table "public"."clip_render_jobs"
  add column if not exists "sort_index" integer not null default 0;

create index if not exists "clip_render_jobs_batch_order_idx"
  on "public"."clip_render_jobs" ("match_map_id", "match_map_demo_id", "created_at", "sort_index");
