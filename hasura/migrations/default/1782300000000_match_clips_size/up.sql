alter table "public"."match_clips"
  add column if not exists "size" bigint not null default 0;

create index if not exists "match_clips_created_at_idx"
  on "public"."match_clips" ("created_at" asc);
