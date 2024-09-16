alter table "public"."match_options" add column if not exists "pause_setting" text
 not null default 'CoachAndPlayers';
