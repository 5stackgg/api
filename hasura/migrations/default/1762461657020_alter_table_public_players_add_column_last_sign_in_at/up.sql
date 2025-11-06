alter table "public"."players" add column if not exists "last_sign_in_at" timestamptz
 null;
