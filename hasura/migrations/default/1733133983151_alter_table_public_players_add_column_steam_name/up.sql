alter table "public"."players" add column if not exists "name_registered" Boolean
 not null default false;


