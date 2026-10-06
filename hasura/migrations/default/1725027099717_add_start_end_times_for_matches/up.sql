alter table "public"."matches" add column if not exists "started_at" timestamptz
 null;

alter table "public"."matches" add column if not exists "ended_at" timestamptz
 null;

alter table "public"."match_maps" add column if not exists "started_at" timestamptz
  null;

 alter table "public"."match_maps" add column if not exists "ended_at" timestamptz
  null;
