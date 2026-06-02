create table if not exists "public"."e_match_clip_visibility" (
  "value" text not null,
  "description" text not null,
  primary key ("value")
);

insert into "public"."e_match_clip_visibility" ("value", "description") values
  ('public', 'Listed in the highlights feed'),
  ('private', 'Only visible to the owner'),
  ('match', 'Visible to match participants and organizers')
on conflict ("value") do update set "description" = excluded."description";

update "public"."match_clips"
  set "visibility" = 'public'
  where "visibility" = 'unlisted';

drop index if exists "public"."match_clips_public_unlisted_created_at_idx";

alter table "public"."match_clips"
  drop constraint if exists "match_clips_visibility_chk";

alter table "public"."match_clips"
  add constraint "match_clips_visibility_fkey"
    foreign key ("visibility")
    references "public"."e_match_clip_visibility" ("value")
    on update cascade on delete restrict;
