alter table "public"."match_clips"
  add column if not exists "knife_kills_count" integer not null default 0;

-- Backfill: the target's knife kills inside the clip's rendered segments,
-- the same window kills_count is counted over.
update "public"."match_clips" c
set "knife_kills_count" = counted.knife_kills
from (
  select clip.id, count(*)::int as knife_kills
  from "public"."match_clips" clip
  join lateral (
    select j.spec
    from "public"."clip_render_jobs" j
    where j.clip_id = clip.id
    order by j.created_at desc
    limit 1
  ) job on true
  join lateral (
    select d.kills
    from "public"."match_map_demos" d
    where d.match_map_id = clip.match_map_id
    order by (d.id is not distinct from clip.match_map_demo_id) desc
    limit 1
  ) demo on true
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(demo.kills) = 'array' then demo.kills else '[]'::jsonb end
  ) as k(kill)
  where (
      clip.target_steam_id is null
      or k.kill ->> 'killer' = clip.target_steam_id::text
    )
    and coalesce(k.kill ->> 'killer', '') <> ''
    and lower(coalesce(k.kill ->> 'weapon', '')) like '%knife%'
    and coalesce(k.kill ->> 'victim', '') <> k.kill ->> 'killer'
    and not (
      coalesce(k.kill ->> 'killer_team', '') <> ''
      and k.kill ->> 'killer_team' = k.kill ->> 'victim_team'
    )
    and exists (
      select 1
      from jsonb_array_elements(
        case when jsonb_typeof(job.spec -> 'segments') = 'array'
          then job.spec -> 'segments' else '[]'::jsonb end
      ) as s(segment)
      where case when jsonb_typeof(k.kill -> 'tick') = 'number'
          then (k.kill ->> 'tick')::numeric end
        between case when jsonb_typeof(s.segment -> 'start_tick') = 'number'
          then (s.segment ->> 'start_tick')::numeric end
        and case when jsonb_typeof(s.segment -> 'end_tick') = 'number'
          then (s.segment ->> 'end_tick')::numeric end
    )
  group by clip.id
) counted
where c.id = counted.id;
