alter table "public"."matches" alter column "type" set default ''competitive'::text';
alter table "public"."matches"
  add constraint "matches_type_fkey"
  foreign key (type)
  references "public"."e_match_types"
  (value) on update cascade on delete restrict;
alter table "public"."matches" alter column "type" drop not null;
alter table "public"."matches" add column "type" text;
