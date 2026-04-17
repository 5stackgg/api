alter table "public"."teams" add column if not exists "avatar_url" text null;
alter table "public"."players" add column if not exists "custom_avatar_url" text null;
