create table if not exists "public"."match_clips" (
  "id" uuid not null default gen_random_uuid(),
  "user_steam_id" bigint not null,
  "match_map_id" uuid not null,
  "title" text,
  "duration_ms" integer,
  "file" text,
  "thumbnail_url" text,
  "visibility" text not null default 'private',
  "target_steam_id" bigint,
  "created_at" timestamptz not null default now(),
  primary key ("id"),
  foreign key ("user_steam_id") references "public"."players" ("steam_id")
    on update cascade on delete cascade,
  foreign key ("match_map_id") references "public"."match_maps" ("id")
    on update cascade on delete cascade,
  foreign key ("target_steam_id") references "public"."players" ("steam_id")
    on update cascade on delete set null,
  constraint match_clips_visibility_chk
    check (visibility in ('private', 'unlisted', 'match', 'public'))
);

create index if not exists "match_clips_user_steam_id_idx"
  on "public"."match_clips" ("user_steam_id");

create index if not exists "match_clips_match_map_id_idx"
  on "public"."match_clips" ("match_map_id");

create index if not exists "match_clips_target_steam_id_idx"
  on "public"."match_clips" ("target_steam_id");

create index if not exists "match_clips_public_created_at_idx"
  on "public"."match_clips" ("created_at" desc)
  where visibility = 'public';

create table if not exists "public"."clip_render_jobs" (
  "id" uuid not null default gen_random_uuid(),
  "user_steam_id" bigint not null,
  "match_map_id" uuid not null,
  "session_token" text not null,
  "k8s_job_name" text not null,
  "spec" jsonb not null,
  "status" text not null default 'queued',
  "progress" numeric(4, 3),
  "error_message" text,
  "clip_id" uuid,
  "status_history" jsonb not null default '[]'::jsonb,
  "last_status_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  primary key ("id"),
  foreign key ("user_steam_id") references "public"."players" ("steam_id")
    on update cascade on delete cascade,
  foreign key ("match_map_id") references "public"."match_maps" ("id")
    on update cascade on delete cascade,
  foreign key ("clip_id") references "public"."match_clips" ("id")
    on update cascade on delete set null,
  constraint clip_render_jobs_status_chk
    check (status in ('queued', 'rendering', 'uploading', 'done', 'error', 'cancelled')),
  constraint clip_render_jobs_progress_chk
    check (progress is null or (progress >= 0 and progress <= 1))
);

create index if not exists "clip_render_jobs_user_steam_id_idx"
  on "public"."clip_render_jobs" ("user_steam_id");

create index if not exists "clip_render_jobs_match_map_id_idx"
  on "public"."clip_render_jobs" ("match_map_id");

alter table "public"."match_map_demos"
  add column if not exists "players" jsonb null;
