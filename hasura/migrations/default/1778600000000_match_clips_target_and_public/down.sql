-- Reverse the public + target_steam_id additions.

drop index if exists "public"."match_clips_public_created_at_idx";

alter table "public"."match_clips"
  drop constraint if exists match_clips_visibility_chk;

alter table "public"."match_clips"
  add constraint match_clips_visibility_chk
    check (visibility in ('private', 'unlisted', 'match'));

drop index if exists "public"."match_clips_target_steam_id_idx";

alter table "public"."match_clips"
  drop constraint if exists match_clips_target_steam_id_fkey;

alter table "public"."match_clips"
  drop column if exists "target_steam_id";
