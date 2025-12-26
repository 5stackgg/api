alter table "public"."tournaments" add column if not exists "created_at" timestamptz
 null default now();
