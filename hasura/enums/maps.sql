insert into e_match_types ("value", "description") values
    ('Competitive', 'The classic 5 vs 5 competitive experience with full team coordination'),
    ('Wingman', 'Team up with a friend and compete in fast-paced 2v2 matches'),
    ('Duel', 'A competitive 1 vs 1 experience, perfect for practicing individual skill'),
    ('Rush', 'Fast-paced 3 vs 3 matches, pushing room by room'),
    ('Premier', 'Valve Premier matchmaking — 5 vs 5 with CS Rating'),
    ('Faceit', 'FACEIT matchmaking — 5 vs 5 imported from FACEIT')
on conflict(value) do update set "description" = EXCLUDED."description";

insert into e_game_cfg_types ("value", "description") values
    ('Base', 'Base game configuration'),
    ('Lan', 'Lan game configuration'),
    ('Live', 'Live game configuration'),
    ('Competitive', 'Competitive game configuration'),
    ('Wingman', 'Wingman game configuration'),
    ('Duel', 'Duel game configuration'),
    ('Rush', 'Rush game configuration'),
    ('Global', 'Applies to every match, on top of the type configuration')
on conflict(value) do update set "description" = EXCLUDED."description";

insert into e_map_pool_types ("value", "description") values
    ('Competitive', '5 vs 5'),
    ('Wingman', '2 vs 2'),
    ('Duel', '1 vs 1'),
    ('Rush', '3 vs 3'),
    ('Custom', 'Custom')
on conflict(value) do update set "description" = EXCLUDED."description";

create or replace function update_map_pools()
returns boolean as $$
declare
    _update_map_pools boolean;
    _replaced uuid[];
begin
    -- Serialised, or a concurrent change never compares against the pool another transaction just swapped in.
    PERFORM pg_advisory_xact_lock(hashtext('update_map_pools'));

    _update_map_pools := COALESCE(NULLIF((SELECT value FROM settings WHERE name = 'update_map_pools'), ''), 'true') = 'true';

    IF _update_map_pools THEN
        -- Replaced rather than edited, so the matches and tournaments already on a pool keep its maps.
        WITH replaced AS (
            UPDATE map_pools p
            SET enabled = false
            WHERE p.seed = true
              AND p.enabled = true
              AND p.type IN ('Competitive', 'Wingman', 'Duel', 'Rush')
              AND EXISTS (SELECT 1 FROM _map_pool mp WHERE mp.map_pool_id = p.id)
              AND EXISTS (
                  SELECT 1 FROM maps m
                  WHERE m.type = p.type AND m.active_pool AND m.enabled AND m.deleted_at IS NULL
              )
              AND (SELECT array_agg(mp.map_id ORDER BY mp.map_id) FROM _map_pool mp WHERE mp.map_pool_id = p.id)
                  IS DISTINCT FROM
                  (
                      SELECT array_agg(m.id ORDER BY m.id) FROM maps m
                      WHERE m.type = p.type AND m.active_pool AND m.enabled AND m.deleted_at IS NULL
                  )
            RETURNING p.id
        )
        SELECT array_agg(id) INTO _replaced FROM replaced;
    END IF;

    -- A pool replaced just now is kept one sync longer, for whatever read it as live a moment ago.
    -- draft_games' foreign key nulls on delete instead of refusing, so it has to be checked here.
    DELETE FROM map_pools p
    WHERE p.seed = true
      AND p.enabled = false
      AND p.id <> ALL (COALESCE(_replaced, '{}'))
      AND NOT EXISTS (SELECT 1 FROM match_options mo WHERE mo.map_pool_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM draft_games dg WHERE dg.map_pool_id = p.id);

    INSERT INTO map_pools ("type", "enabled", "seed")
    SELECT t.type, true, true
    FROM (VALUES ('Competitive'), ('Wingman'), ('Duel'), ('Rush')) AS t(type)
    WHERE NOT EXISTS (
        SELECT 1 FROM map_pools p
        WHERE p.type = t.type AND p.seed = true AND p.enabled = true
    );

    -- An empty enabled seed pool is new, not emptied by an operator, so it is filled even with updates off.
    INSERT INTO _map_pool (map_id, map_pool_id)
    SELECT m.id, p.id
    FROM map_pools p
    JOIN maps m ON m.type = p.type AND m.active_pool AND m.enabled AND m.deleted_at IS NULL
    WHERE p.seed = true
      AND p.enabled = true
      AND NOT EXISTS (SELECT 1 FROM _map_pool mp WHERE mp.map_pool_id = p.id)
    ON CONFLICT DO NOTHING;

    RETURN _update_map_pools;
end;
$$ language plpgsql;

WITH map_data AS (
    SELECT * FROM (VALUES
        -- Valve maps
        ('de_ancient', null, '/img/maps/screenshots/de_ancient.webp', '/img/maps/icons/de_ancient.svg', null),
        ('de_ancient_night', null, '/img/maps/screenshots/de_ancient_night.webp', '/img/maps/icons/de_ancient_night.svg', null),
        ('de_anubis', null, '/img/maps/screenshots/de_anubis.webp', '/img/maps/icons/de_anubis.svg', null),
        ('de_inferno', null, '/img/maps/screenshots/de_inferno.webp', '/img/maps/icons/de_inferno.svg', null),
        ('de_inferno_night', '3124567099', '/img/maps/screenshots/de_inferno_night.webp', '/img/maps/icons/de_inferno.svg', null),
        ('de_mirage', null, '/img/maps/screenshots/de_mirage.webp', '/img/maps/icons/de_mirage.svg', null),
        ('de_nuke', null, '/img/maps/screenshots/de_nuke.webp', '/img/maps/icons/de_nuke.svg', null),
        ('de_nuke_night', '3253703883', '/img/maps/screenshots/de_nuke_night.webp', '/img/maps/icons/de_nuke.svg', null),
        ('de_overpass', null, '/img/maps/screenshots/de_overpass.webp', '/img/maps/icons/de_overpass.svg', null),
        ('de_overpass_night', '3285124923', '/img/maps/screenshots/de_overpass_night.webp', '/img/maps/icons/de_overpass.svg', null),
        ('de_vertigo', null, '/img/maps/screenshots/de_vertigo.webp', '/img/maps/icons/de_vertigo.svg', null),
        ('de_dust2', null, '/img/maps/screenshots/de_dust2.webp', '/img/maps/icons/de_dust2.svg', null),
        ('de_dust2_night', '3296013569', '/img/maps/screenshots/de_dust2_night.webp', '/img/maps/icons/de_dust2.svg', null),
        ('de_train', null, '/img/maps/screenshots/de_train.webp', '/img/maps/icons/de_train.svg', null),
        ('cs_office', null, '/img/maps/screenshots/cs_office.webp', '/img/maps/icons/cs_office.svg', null),
        ('cs_italy', null, '/img/maps/screenshots/cs_italy.webp', '/img/maps/icons/cs_italy.svg', null),
        ('de_cache', null, '/img/maps/screenshots/de_cache.webp', '/img/maps/icons/de_cache.svg', null),
        -- Workshop maps
        ('de_thera', '3121217565', '/img/maps/screenshots/de_thera.webp', '/img/maps/icons/de_thera.svg', null),
        ('de_mills', '3152430710', '/img/maps/screenshots/de_mills.webp', '/img/maps/icons/de_mills.svg', null),    
        ('de_edin', '3328169568', '/img/maps/screenshots/de_edin.webp', '/img/maps/icons/de_edin.svg', null),
        ('de_basalt', '3329258290', '/img/maps/screenshots/de_basalt.webp', '/img/maps/icons/de_basalt.svg', null),
        ('de_grail', '3246527710', '/img/maps/screenshots/de_grail.webp', '/img/maps/icons/de_grail.svg', null),
        ('de_jura', '3261289969', '/img/maps/screenshots/de_jura.webp', '/img/maps/icons/de_jura.svg', null),
        ('de_brewery', '3070290240', '/img/maps/screenshots/de_brewery.webp', '/img/maps/icons/de_brewery.svg', null),
        ('de_assembly', '3071005299', '/img/maps/screenshots/de_assembly.webp', '/img/maps/icons/de_assembly.svg', null),
        ('de_memento', '3165559377', '/img/maps/screenshots/de_memento.webp', '/img/maps/icons/de_memento.svg', null),
        ('de_palais', '2891200262', '/img/maps/screenshots/de_palais.webp', '/img/maps/icons/de_palais.svg', null),
        ('de_whistle', '3308613773', '/img/maps/screenshots/de_whistle.webp', '/img/maps/icons/de_whistle.svg', null),
        ('de_dogtown', '3414036782', '/img/maps/screenshots/de_dogtown.webp', '/img/maps/icons/de_dogtown.svg', null),
        ('de_golden', '3286163323', '/img/maps/screenshots/de_golden.webp', '/img/maps/icons/de_golden.svg', null),
        ('de_palacio', '3249860053', '/img/maps/screenshots/de_palacio.webp', '/img/maps/icons/de_palacio.svg', null),
        ('de_rooftop', '3536622725', '/img/maps/screenshots/de_rooftop.webp', '/img/maps/icons/de_rooftop.svg', null),
        ('de_transit', '3542662073', '/img/maps/screenshots/de_transit.webp', '/img/maps/icons/de_transit.svg', null),
        ('de_poseidon', '3522144043', '/img/maps/screenshots/de_poseidon.webp', '/img/maps/icons/de_poseidon.svg', null),
        ('de_sanctum', '3643331442', '/img/maps/screenshots/de_sanctum.webp', '/img/maps/icons/de_sanctum.svg', null),
        ('de_stronghold', '3076973469', '/img/maps/screenshots/de_stronghold.webp', '/img/maps/icons/de_stronghold.svg', null),
        ('de_warden', '3256988376', '/img/maps/screenshots/de_warden.webp', '/img/maps/icons/de_warden.svg', null),
        ('de_boulder', '3663186989', '/img/maps/screenshots/de_boulder.webp', '/img/maps/icons/de_boulder.svg', null),
        ('de_debris', '3539217452', '/img/maps/screenshots/de_debris.webp', '/img/maps/icons/de_debris.svg', null),
        ('de_eldorado', '3408790618', '/img/maps/screenshots/de_eldorado.webp', '/img/maps/icons/de_eldorado.svg', null),
        ('de_fachwerk', '3442040035', '/img/maps/screenshots/de_fachwerk.webp', '/img/maps/icons/de_fachwerk.svg', null),
        ('cs_shelter', '3737179295', '/img/maps/screenshots/cs_shelter.webp', '/img/maps/icons/cs_shelter.svg', null),
        ('rush_001', null, '/img/maps/screenshots/rush_001.webp', '/img/maps/icons/rush_001.svg', null)

    ) AS data(name, workshop_map_id, poster, patch, label)
),
map_type_config AS (
    SELECT * FROM (VALUES
        -- Competitive maps
        ('de_ancient', 'Competitive', true),
        ('de_ancient_night', 'Competitive', false),
        ('de_anubis', 'Competitive', true),
        ('de_inferno', 'Competitive', true),
        ('de_inferno_night', 'Competitive', false),
        ('de_mirage', 'Competitive', true),
        ('de_nuke', 'Competitive', true),
        ('de_nuke_night', 'Competitive', false),
        ('de_overpass', 'Competitive', false),
        ('de_overpass_night', 'Competitive', false),
        ('de_vertigo', 'Competitive', false),
        ('de_dust2', 'Competitive', true),
        ('de_dust2_night', 'Competitive', false),
        ('de_train', 'Competitive', false),
        ('cs_office', 'Competitive', false),
        ('cs_italy', 'Competitive', false),
        ('cs_shelter', 'Competitive', false),
        ('de_cache', 'Competitive', true),
        ('de_thera', 'Competitive', false),
        ('de_mills', 'Competitive', false),
        ('de_edin', 'Competitive', false),
        ('de_basalt', 'Competitive', false),
        ('de_grail', 'Competitive', false),
        ('de_jura', 'Competitive', false),
        ('de_golden', 'Competitive', false),
        ('de_palacio', 'Competitive', false),
        ('de_stronghold', 'Competitive', false),
        ('de_warden', 'Competitive', false),
        ('de_boulder', 'Competitive', false),
        ('de_fachwerk', 'Competitive', false),

        -- Wingman maps
        ('de_inferno', 'Wingman', true),
        ('de_nuke', 'Wingman', true),
        ('de_overpass', 'Wingman', true),
        ('de_vertigo', 'Wingman', true),
        ('de_brewery', 'Wingman', false),
        ('de_assembly', 'Wingman', false),
        ('de_memento', 'Wingman', false),
        ('de_palais', 'Wingman', false),
        ('de_whistle', 'Wingman', false),
        ('de_dogtown', 'Wingman', false),
        ('de_rooftop', 'Wingman', false),
        ('de_transit', 'Wingman', false),
        ('de_poseidon', 'Wingman', true),
        ('de_sanctum', 'Wingman', false),
        ('de_debris', 'Wingman', true),
        ('de_eldorado', 'Wingman', true),

        -- Duel maps
        ('de_inferno', 'Duel', true),
        ('de_nuke', 'Duel', true),
        ('de_overpass', 'Duel', true),
        ('de_vertigo', 'Duel', true),
        ('de_brewery', 'Duel', false),
        ('de_assembly', 'Duel', false),
        ('de_memento', 'Duel', false),
        ('de_palais', 'Duel', false),
        ('de_whistle', 'Duel', false),
        ('de_dogtown', 'Duel', false),
        ('de_rooftop', 'Duel', false),
        ('de_transit', 'Duel', false),
        ('de_poseidon', 'Duel', true),
        ('de_sanctum', 'Duel', false),
        ('de_debris', 'Duel', true),
        ('de_eldorado', 'Duel', true),

        -- Rush maps
        ('rush_001', 'Rush', true)

    ) AS data(name, type, active_pool)
),
retired_map_types AS (
    SELECT * FROM (VALUES
        ('de_debris', 'Competitive'),
        ('de_eldorado', 'Competitive')
    ) AS data(name, type)
),
all_maps AS (
    SELECT 
        md.name,
        mtc.type,
        mtc.active_pool,
        md.workshop_map_id,
        md.poster,
        md.patch,
        md.label
    FROM map_data md
    JOIN map_type_config mtc ON md.name = mtc.name
),
seeded AS (
insert into maps (
    "name", 
    "type", 
    "active_pool", 
    "workshop_map_id", 
    "poster", 
    "patch", 
    "label",
    "seeded"
)
SELECT 
    name,
    type,
    active_pool,
    workshop_map_id,
    poster,
    patch,
    label,
    true
FROM all_maps
on conflict("name", "type") do update set 
    "active_pool" = EXCLUDED."active_pool", 
    "workshop_map_id" = EXCLUDED."workshop_map_id", 
    "poster" = EXCLUDED."poster", 
    "patch" = EXCLUDED."patch", 
    "label" = EXCLUDED."label",
    "seeded" = true
),
unseeded AS (
UPDATE maps
SET seeded = false
WHERE seeded
  AND name NOT IN (SELECT name FROM map_data)
)
-- A map's details belong to the map, not one mode, so the mode rows the seed does not list (an
-- admin's, or one it retired) carry them too; only a retired mode is switched off.
UPDATE maps m
SET workshop_map_id = md.workshop_map_id,
    poster = md.poster,
    patch = md.patch,
    label = md.label,
    seeded = true,
    enabled = m.enabled AND NOT EXISTS (
        SELECT 1 FROM retired_map_types r WHERE r.name = m.name AND r.type = m.type
    )
FROM map_data md
WHERE m.name = md.name
  AND NOT EXISTS (SELECT 1 FROM map_type_config mtc WHERE mtc.name = m.name AND mtc.type = m.type);

DO $$
BEGIN
    PERFORM update_map_pools();
END;
$$;
