SET check_function_bodies = false;

insert into maps ("name", "type", "active_pool", "workshop_map_id", "poster", "patch") values
    --  Competitive
    ('de_ancient', 'Competitive', 'true',  null, '/img/maps/posters/ancient.webp', '/img/maps/patches/ancient.webp'),
    ('de_anubis', 'Competitive', 'true',  null, '/img/maps/posters/anubis.webp', '/img/maps/patches/anubis.webp'),
    ('de_inferno', 'Competitive', 'true',  null, '/img/maps/posters/inferno.webp', '/img/maps/patches/inferno.webp'),
    ('de_mirage', 'Competitive', 'true',  null, '/img/maps/posters/mirage.webp', '/img/maps/patches/mirage.webp'),
    ('de_nuke', 'Competitive', 'true',  null, '/img/maps/posters/nuke.webp', '/img/maps/patches/nuke.webp'),
    ('de_overpass', 'Competitive', 'false',  null, '/img/maps/posters/overpass.webp', '/img/maps/patches/overpass.webp'),
    ('de_vertigo', 'Competitive', 'true',  null, '/img/maps/posters/vertigo.webp', '/img/maps/patches/vertigo.webp'),
    ('de_dust2', 'Competitive', 'true',  null, '/img/maps/posters/dust2.webp', '/img/maps/patches/dust2.webp'),
    ('de_thera', 'Competitive', 'false',  null, '/img/maps/posters/thera.webp', '/img/maps/patches/thera.webp'),
    ('de_mills', 'Competitive', 'false',  null, '/img/maps/posters/mills.webp', '/img/maps/patches/mills.webp'),

    -- Competitive Workshop
    ('de_cache', 'Competitive', 'false',  '3070596702', null, null),
    ('de_train', 'Competitive', 'false',  '3070284539', null, null),
    ('de_cbble', 'Competitive', 'false',  '3070212801', null, null),
    ('de_biome', 'Competitive', 'false',  '3075706807', null, null),
    ('drawbridge', 'Competitive', 'false',  '3070192462', null, null),
    ('foroglio', 'Competitive', 'false',  '3132854332', null, null),

    --  Wingman
    ('de_inferno', 'Wingman', 'false',  null, '/img/maps/posters/inferno.webp', '/img/maps/patches/inferno.webp'),
    ('de_nuke', 'Wingman', 'false',  null, '/img/maps/posters/nuke.webp', '/img/maps/patches/nuke.webp'),
    ('de_overpass', 'Wingman', 'false',  null, '/img/maps/posters/overpass.webp', '/img/maps/patches/overpass.webp'),
    ('de_vertigo', 'Wingman', 'false',  null, '/img/maps/posters/vertigo.webp', '/img/maps/patches/vertigo.webp'),
    ('de_assembly', 'Wingman', 'false',  null, '/img/maps/posters/assembly.webp', '/img/maps/patches/assembly.webp'),
    ('de_memento', 'Wingman', 'false',  null, '/img/maps/posters/memento.webp', '/img/maps/patches/memento.webp'),

    --  Wingman Workshop
    ('de_brewery', 'Wingman', 'false',  '3070290240', null, null),
    ('drawbridge', 'Wingman', 'false',  '3070192462', null, null),
    ('foroglio', 'Wingman', 'false',  '3132854332', null, null)

on conflict(name, type) do update set "active_pool" = EXCLUDED."active_pool", "workshop_map_id" = EXCLUDED."workshop_map_id", "poster" = EXCLUDED."poster", "patch" = EXCLUDED."patch";

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