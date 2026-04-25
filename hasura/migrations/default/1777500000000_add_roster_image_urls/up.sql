alter table "public"."players" add column if not exists "roster_image_url" text null;
alter table "public"."team_roster" add column if not exists "roster_image_url" text null;
