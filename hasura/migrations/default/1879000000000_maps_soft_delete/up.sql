alter table "public"."maps" add column if not exists "deleted_at" timestamptz null;
