alter table "public"."matches" add column "started_at" timestamptz
 null;

alter table "public"."matches" add column "ended_at" timestamptz
 null;

alter table "public"."match_maps" add column "started_at" timestamptz
  null;

 alter table "public"."match_maps" add column "ended_at" timestamptz
  null;
