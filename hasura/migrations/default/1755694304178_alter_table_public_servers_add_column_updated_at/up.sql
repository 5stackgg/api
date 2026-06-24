alter table "public"."servers" add column IF NOT EXISTS "updated_at" timestamptz
 null default now();
