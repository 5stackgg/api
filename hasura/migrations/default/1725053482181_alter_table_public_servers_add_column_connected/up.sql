alter table "public"."servers" add column if not exists "connected" Boolean
 not null default 'false';
