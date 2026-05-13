create index if not exists "match_clips_public_unlisted_created_at_idx"
  on "public"."match_clips" ("created_at" desc)
  where visibility in ('public', 'unlisted');
