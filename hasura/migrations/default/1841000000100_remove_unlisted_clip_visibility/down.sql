alter table "public"."match_clips"
  drop constraint if exists "match_clips_visibility_fkey";

alter table "public"."match_clips"
  add constraint "match_clips_visibility_chk"
    check (visibility in ('private', 'unlisted', 'match', 'public'));

create index if not exists "match_clips_public_unlisted_created_at_idx"
  on "public"."match_clips" ("created_at" desc)
  where visibility in ('public', 'unlisted');

drop table if exists "public"."e_match_clip_visibility";
