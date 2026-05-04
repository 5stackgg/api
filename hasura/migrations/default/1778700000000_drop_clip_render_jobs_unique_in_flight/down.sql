-- Restore the per-user one-in-flight unique index.
create unique index if not exists "clip_render_jobs_one_in_flight_per_user"
  on "public"."clip_render_jobs" ("user_steam_id")
  where status in ('queued', 'rendering', 'uploading');
