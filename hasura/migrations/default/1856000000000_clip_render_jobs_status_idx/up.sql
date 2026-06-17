-- Serves the render-queue subscriptions' status filter + created_at ordering.
create index if not exists "clip_render_jobs_status_created_at_idx"
  on "public"."clip_render_jobs" ("status", "created_at" desc);
