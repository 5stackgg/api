SET check_function_bodies = false;

insert into e_match_types ("value", "description") values
    ('Competitive', '5 vs 5 match using active map pool'),
    ('Scrimmage', '5 vs 5 match using all available map pools'),
    ('ScrimmageNight', '5 vs 5 match using the night map pool'),
    ('Wingman', '2 vs 2 match')
on conflict(value) do update set "description" = EXCLUDED."description";

insert into maps ("name", "type", "active_pool", "workshop_map_id", "poster", "patch") values
    --  Competitive
    ('de_ancient', 'Competitive', 'true',  null, '/img/maps/screenshots/de_ancient.png', '/img/maps/icons/de_ancient.svg'),
    ('de_anubis', 'Competitive', 'true',  null, '/img/maps/screenshots/de_anubis.png', '/img/maps/icons/de_anubis.svg'),
    ('de_inferno', 'Competitive', 'true',  null, '/img/maps/screenshots/de_inferno.png', '/img/maps/icons/de_inferno.svg'),
    ('de_mirage', 'Competitive', 'true',  null, '/img/maps/screenshots/de_mirage.png', '/img/maps/icons/de_mirage.svg'),
    ('de_nuke', 'Competitive', 'true',  null, '/img/maps/screenshots/de_nuke.png', '/img/maps/icons/de_nuke.svg'),
    ('de_overpass', 'Competitive', 'false',  null, '/img/maps/screenshots/de_overpass.png', '/img/maps/icons/de_overpass.svg'),
    ('de_vertigo', 'Competitive', 'true',  null, '/img/maps/screenshots/de_vertigo.png', '/img/maps/icons/de_vertigo.svg'),
    ('de_dust2', 'Competitive', 'true',  null, '/img/maps/screenshots/de_dust2.png', '/img/maps/icons/de_dust2.svg'),
    ('de_thera', 'Competitive', 'false',  null, '/img/maps/screenshots/de_thera.png', '/img/maps/icons/de_thera.svg'),
    ('de_mills', 'Competitive', 'false',  null, '/img/maps/screenshots/de_mills.png', '/img/maps/icons/de_mills.svg'),

    -- Competitive Workshop
    ('de_cache', 'Competitive', 'false',  '3070596702', '/img/maps/screenshots/de_cache.png', '/img/maps/icons/de_cache.svg'),
    ('de_train', 'Competitive', 'false',  '3070284539', '/img/maps/screenshots/de_train.png', null),
    ('de_cbble', 'Competitive', 'false',  '3070212801', '/img/maps/screenshots/de_cbble.png', null),
    ('de_biome', 'Competitive', 'false',  '3075706807', '/img/maps/screenshots/de_biome.png', null),
    ('drawbridge', 'Competitive', 'false',  '3070192462', '/img/maps/screenshots/de_drawbridge.png', null),
    ('foroglio', 'Competitive', 'false',  '3132854332', '/img/maps/screenshots/de_foroglio.png', null),

    ('de_dust2_night', 'ScrimmageNight', 'false', '3296013569', '/img/maps/screenshots/de_dust2_night.png', '/img/maps/icons/de_dust2.svg'),
    ('de_ancient_night', 'ScrimmageNight', 'false', '3299281893', '/img/maps/screenshots/de_ancient_night.png', '/img/maps/icons/de_ancient.svg'),
    ('de_overpass_night', 'ScrimmageNight', 'false', '3285124923', '/img/maps/screenshots/de_overpass_night.png', '/img/maps/icons/de_overpass.svg'),
    ('de_nuke_night', 'ScrimmageNight', 'false', '3253703883', '/img/maps/screenshots/de_nuke_night.png', '/img/maps/icons/de_nuke.svg'),
    ('de_inferno_night', 'ScrimmageNight', 'false', '3124567099', '/img/maps/screenshots/de_inferno_night.png', '/img/maps/icons/de_inferno.svg'),

    --  Wingman
    ('de_inferno', 'Wingman', 'false',  null, '/img/maps/screenshots/de_inferno.png', '/img/maps/icons/de_inferno.svg'),
    ('de_nuke', 'Wingman', 'false',  null, '/img/maps/screenshots/de_nuke.png', '/img/maps/icons/de_nuke.svg'),
    ('de_overpass', 'Wingman', 'false',  null, '/img/maps/screenshots/de_overpass.png', '/img/maps/icons/de_overpass.svg'),
    ('de_vertigo', 'Wingman', 'false',  null, '/img/maps/screenshots/de_vertigo.png', '/img/maps/icons/de_vertigo.svg'),
    ('de_assembly', 'Wingman', 'false',  null, '/img/maps/screenshots/de_assembly.png', '/img/maps/icons/de_assembly.svg'),
    ('de_memento', 'Wingman', 'false',  null, '/img/maps/screenshots/de_memento.png', '/img/maps/icons/de_memento.svg'),

    --  Wingman Workshop
    ('de_brewery', 'Wingman', 'false',  '3070290240', '/img/maps/screenshots/de_brewery.png', '/img/maps/icons/de_brewery.svg'),
    ('drawbridge', 'Wingman', 'false',  '3070192462', '/img/maps/screenshots/de_drawbridge.png', null),
    ('foroglio', 'Wingman', 'false',  '3132854332', '/img/maps/screenshots/de_foroglio.png', null)

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