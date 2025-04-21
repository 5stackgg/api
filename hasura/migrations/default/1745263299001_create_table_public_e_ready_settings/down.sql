alter table "public"."match_options" drop constraint "match_options_ready_setting_fkey";

alter table "public"."match_options" drop column "ready_setting";

DROP TABLE "public"."e_ready_settings";
