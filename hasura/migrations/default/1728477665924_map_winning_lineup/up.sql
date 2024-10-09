alter table "public"."match_maps" add column if not exists "winning_lineup_id" uuid
 null;