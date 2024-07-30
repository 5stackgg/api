SET check_function_bodies = false;

insert into e_match_types ("value", "description") values
    ('Competitive', '5 vs 5 match using active map pool'),
    ('Scrimmage', '5 vs 5 match using all available map pools'),
    ('ScrimmageNight', '5 vs 5 match using the night map pool'),
    ('Wingman', '2 vs 2 match')
on conflict(value) do update set "description" = EXCLUDED."description";

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
    ('de_cache', 'Competitive', 'false',  '3070596702', '/img/maps/posters/cache.jpeg', null),
    ('de_train', 'Competitive', 'false',  '3070284539', '/img/maps/posters/train.jpeg', null),
    ('de_cbble', 'Competitive', 'false',  '3070212801', '/img/maps/posters/cbble.jpeg', null),
    ('de_biome', 'Competitive', 'false',  '3075706807', '/img/maps/posters/biome.jpeg', null),
    ('drawbridge', 'Competitive', 'false',  '3070192462', '/img/maps/posters/drawbridge.jpeg', null),
    ('foroglio', 'Competitive', 'false',  '3132854332', '/img/maps/posters/foroglio.jpeg', null),

    ('de_dust2_night', 'ScrimmageNight', 'false', '3296013569', '/img/maps/posters/dust2_night.jpeg', null),
    ('de_ancient_night', 'ScrimmageNight', 'false', '3299281893', '/img/maps/posters/ancient_night.jpeg', null),
    ('de_overpass_night', 'ScrimmageNight', 'false', '3285124923', '/img/maps/posters/overpass_night.jpeg', null),
    ('de_nuke_night', 'ScrimmageNight', 'false', '3253703883', '/img/maps/posters/nuke_night.jpeg', null),
    ('de_inferno_night', 'ScrimmageNight', 'false', '3124567099', '/img/maps/posters/inferno_night.jpeg', null),

    --  Wingman
    ('de_inferno', 'Wingman', 'false',  null, '/img/maps/posters/inferno.webp', '/img/maps/patches/inferno.webp'),
    ('de_nuke', 'Wingman', 'false',  null, '/img/maps/posters/nuke.webp', '/img/maps/patches/nuke.webp'),
    ('de_overpass', 'Wingman', 'false',  null, '/img/maps/posters/overpass.webp', '/img/maps/patches/overpass.webp'),
    ('de_vertigo', 'Wingman', 'false',  null, '/img/maps/posters/vertigo.webp', '/img/maps/patches/vertigo.webp'),
    ('de_assembly', 'Wingman', 'false',  null, '/img/maps/posters/assembly.jpeg', null),
    ('de_memento', 'Wingman', 'false',  null, '/img/maps/posters/memento.jpeg', null),

    --  Wingman Workshop
    ('de_brewery', 'Wingman', 'false',  '3070290240', '/img/maps/posters/brewery.jpeg', null),
    ('drawbridge', 'Wingman', 'false',  '3070192462', '/img/maps/posters/drawbridge.jpeg', null),
    ('foroglio', 'Wingman', 'false',  '3132854332', '/img/maps/posters/foroglio.jpeg', null)

on conflict(name, type) do update set "active_pool" = EXCLUDED."active_pool", "workshop_map_id" = EXCLUDED."workshop_map_id", "poster" = EXCLUDED."poster", "patch" = EXCLUDED."patch";

insert into e_map_pool_types ("value", "description") values
    ('Competitive', '5 vs 5 match using active map pool'),
    ('Scrimmage', '5 vs 5 match using all available map pools'),
    ('ScrimmageNight', '5 vs 5 match using the night map pool'),
    ('Wingman', '2 vs 2 match'),
    ('Custom', 'Custom match')
on conflict(value) do update set "description" = EXCLUDED."description";

WITH new_rows AS (
  SELECT *
  FROM (VALUES
      ('Competitive', true, true),
      ('Scrimmage', true, true),
      ('ScrimmageNight', true, true),
      ('Wingman', true, true)
  ) AS data(type, enabled, seed)
)
INSERT INTO map_pools ("type", "enabled", "seed")
SELECT type, enabled, seed
FROM new_rows
WHERE NOT EXISTS (
  SELECT 1
  FROM map_pools
  WHERE map_pools.type = new_rows.type
    AND map_pools.seed = true
);

WITH pool_ids AS (
    SELECT id, type
    FROM map_pools
    WHERE type IN ('Competitive', 'Wingman', 'Scrimmage', 'ScrimmageNight')
    ORDER BY type
),
inserted_maps AS (
    INSERT INTO _map_pool (map_id, map_pool_id)
    SELECT m.id, p.id
    FROM maps m
    JOIN pool_ids p ON (
        (p.type = 'Competitive' AND m.type = 'Competitive' AND m.active_pool = 'true') OR
        (p.type = 'Wingman' AND m.type = 'Wingman') OR
        (p.type = 'Scrimmage' AND m.type = 'Competitive') OR
        (p.type = 'ScrimmageNight' AND m.type = 'ScrimmageNight')
    )
    ON CONFLICT DO NOTHING
    RETURNING *
)
SELECT im.map_id, pi.type
FROM inserted_maps im
JOIN pool_ids pi ON im.map_pool_id = pi.id;