drop index if exists "public"."clip_render_jobs_batch_order_idx";

alter table "public"."clip_render_jobs"
  drop column if exists "sort_index";
