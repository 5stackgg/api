-- Two changes for the public-highlights browse + clip metadata edit:
--
-- 1. target_steam_id — the player whose POV / kills the clip is
--    about. Filled by the api when a preset clip is rendered (it's
--    the same target the spec lock pinned), and editable later via
--    updateClip. NULL for manual-trim clips that aren't about a
--    specific player.
--
-- 2. Loosen the visibility check to allow 'public' so users can opt
--    into the global highlights feed. 'private' stays the default.

alter table "public"."match_clips"
  add column if not exists "target_steam_id" bigint;

alter table "public"."match_clips"
  add constraint match_clips_target_steam_id_fkey
    foreign key ("target_steam_id")
    references "public"."players" ("steam_id")
    on update cascade on delete set null;

create index if not exists "match_clips_target_steam_id_idx"
  on "public"."match_clips" ("target_steam_id");

-- Visibility: drop + recreate the check constraint to add 'public'.
-- Have to drop first because Postgres treats check constraints as
-- atomic; can't ALTER ... USING.
alter table "public"."match_clips"
  drop constraint if exists match_clips_visibility_chk;

alter table "public"."match_clips"
  add constraint match_clips_visibility_chk
    check (visibility in ('private', 'unlisted', 'match', 'public'));

-- Index public clips by created_at for the public-highlights feed.
-- Partial index keeps it cheap — public is the minority case.
create index if not exists "match_clips_public_created_at_idx"
  on "public"."match_clips" ("created_at" desc)
  where visibility = 'public';
