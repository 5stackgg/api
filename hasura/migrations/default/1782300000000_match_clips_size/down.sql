drop index if exists "public"."match_clips_created_at_idx";

alter table "public"."match_clips" drop column if exists "size";
