drop index if exists "public"."clip_render_jobs_paused_in_flight_idx";

alter table "public"."clip_render_jobs"
  drop column if exists "paused";
