SET check_function_bodies = false;

insert into maps ("name", "type", "active_pool", "workshop_map_id") values
    --  Competitive
    ('de_ancient', 'Competitive', 'true',  null),
    ('de_anubis', 'Competitive', 'true',  null),
    ('de_inferno', 'Competitive', 'true',  null),
    ('de_mirage', 'Competitive', 'true',  null),
    ('de_nuke', 'Competitive', 'true',  null),
    ('de_overpass', 'Competitive', 'false',  null),
    ('de_vertigo', 'Competitive', 'true',  null),
    ('de_dust2', 'Competitive', 'true',  null),
    ('de_thera', 'Competitive', 'true',  null),
    ('de_mills', 'Competitive', 'true',  null),

    -- Competitive Workshop
    ('de_cache', 'Competitive', 'false',  '3070596702'),
    ('de_train', 'Competitive', 'false',  '3070284539'),
    ('de_cbble', 'Competitive', 'false',  '3070212801'),
    ('de_biome', 'Competitive', 'false',  '3075706807'),
    ('drawbridge', 'Competitive', 'false',  '3070192462'),
    ('foroglio', 'Competitive', 'false',  '3132854332'),

    --  Wingman
    ('de_inferno', 'Wingman', 'true',  null),
    ('de_nuke', 'Wingman', 'true',  null),
    ('de_overpass', 'Wingman', 'false',  null),
    ('de_vertigo', 'Wingman', 'true',  null),
    ('assembly', 'Wingman', 'true',  null),
    ('memento', 'Wingman', 'true',  null),

    --  Wingman Workshop
    ('de_brewery', 'Wingman', 'false',  '3070290240'),
    ('drawbridge', 'Wingman', 'false',  '3070192462'),
    ('foroglio', 'Wingman', 'false',  '3132854332')

on conflict(name, type) do update set "active_pool" = EXCLUDED."active_pool", "workshop_map_id" = EXCLUDED."workshop_map_id";

WITH new_rows AS (
  SELECT *
  FROM (VALUES
      ('Competitive', true, null::bigint),
      ('Wingman', true, null::bigint),
      ('Scrimmage', true, null::bigint)
  ) AS data(label, enabled, owner_steam_id)
)
INSERT INTO map_pools ("label", "enabled", "owner_steam_id")
SELECT label, enabled, owner_steam_id
FROM new_rows
WHERE NOT EXISTS (
  SELECT 1
  FROM map_pools
  WHERE map_pools.label = new_rows.label
    AND map_pools.owner_steam_id IS NULL
);

WITH pool_ids AS (
    SELECT id, label
    FROM map_pools
    WHERE label IN ('Competitive', 'Wingman', 'Scrimmage')
    ORDER BY label
),
inserted_maps AS (
    INSERT INTO _map_pool (map_id, map_pool_id)
    SELECT m.id, p.id
    FROM maps m
    JOIN pool_ids p ON (
        (p.label = 'Competitive' AND m.type = 'Competitive' AND m.active_pool = 'true') OR
        (p.label = 'Wingman' AND m.type = 'Wingman') OR
        (p.label = 'Scrimmage' AND m.type = 'Competitive')
    )
    ON CONFLICT DO NOTHING
    RETURNING *
)
SELECT im.map_id, pi.label
FROM inserted_maps im
JOIN pool_ids pi ON im.map_pool_id = pi.id;