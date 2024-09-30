alter table "public"."match_options" add column if not exists "lobby_access" text
 null default 'Private';
