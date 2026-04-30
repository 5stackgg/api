create table if not exists "public"."match_demo_sessions" (
  "id" uuid not null default gen_random_uuid(),
  "match_map_id" uuid not null,
  "match_id" uuid not null,
  "watcher_steam_id" bigint not null,
  "session_token" text not null,
  "k8s_job_name" text not null,
  "stream_url" text,
  "status" text not null default 'booting',
  "error_message" text,
  "last_status_at" timestamptz not null default now(),
  "last_activity_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  primary key ("id"),
  foreign key ("match_id") references "public"."matches" ("id")
    on update cascade on delete cascade,
  foreign key ("match_map_id") references "public"."match_maps" ("id")
    on update cascade on delete cascade,
  foreign key ("watcher_steam_id") references "public"."players" ("steam_id")
    on update cascade on delete cascade
);

create unique index if not exists "match_demo_sessions_per_user_per_map_uniq"
  on "public"."match_demo_sessions" ("match_map_id", "watcher_steam_id");

create index if not exists "match_demo_sessions_match_id_idx"
  on "public"."match_demo_sessions" ("match_id");

create index if not exists "match_demo_sessions_last_activity_at_idx"
  on "public"."match_demo_sessions" ("last_activity_at");
