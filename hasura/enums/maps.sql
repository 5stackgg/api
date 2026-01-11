insert into e_match_types ("value", "description") values
    ('Competitive', 'The classic 5 vs 5 competitive experience with full team coordination'),
    ('Wingman', 'Team up with a friend and compete in fast-paced 2v2 matches'),
    ('Duel', 'A competitive 1 vs 1 experience, perfect for practicing individual skill')
on conflict(value) do update set "description" = EXCLUDED."description";

insert into e_game_cfg_types ("value", "description") values
    ('Base', 'Base game configuration'),
    ('Lan', 'Lan game configuration'),
    ('Live', 'Live game configuration'),
    ('Competitive', 'Competitive game configuration'),
    ('Wingman', 'Wingman game configuration'),
    ('Duel', 'Duel game configuration')
on conflict(value) do update set "description" = EXCLUDED."description";

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
        -- Workshop maps
        ('de_cache', '3437809122', '/img/maps/screenshots/de_cache.webp', '/img/maps/icons/de_cache.svg', null),
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
        ('de_golden', null, '/img/maps/screenshots/de_golden.webp', '/img/maps/icons/de_golden.svg', null),
        ('de_palacio', null, '/img/maps/screenshots/de_palacio.webp', '/img/maps/icons/de_palacio.svg', null),
        ('de_rooftop', null, '/img/maps/screenshots/de_rooftop.webp', '/img/maps/icons/de_rooftop.svg', null),
        ('de_transit', '3542662073', '/img/maps/screenshots/de_transit.webp', '/img/maps/icons/de_transit.svg', null)
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
        ('de_overpass', 'Competitive', true),
        ('de_overpass_night', 'Competitive', false),
        ('de_vertigo', 'Competitive', false),
        ('de_dust2', 'Competitive', true),
        ('de_dust2_night', 'Competitive', false),
        ('de_train', 'Competitive', false),
        ('de_cache', 'Competitive', false),
        ('de_thera', 'Competitive', false),
        ('de_mills', 'Competitive', false),
        ('de_edin', 'Competitive', false),
        ('de_basalt', 'Competitive', false),
        ('de_grail', 'Competitive', false),
        ('de_jura', 'Competitive', false),
        ('de_golden', 'Competitive', false),
        ('de_palacio', 'Competitive', false),
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
        ('de_rooftop', 'Wingman', true),
        ('de_transit', 'Wingman', false),
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
        ('de_rooftop', 'Duel', true),
        ('de_transit', 'Duel', false)
    ) AS data(name, type, active_pool)
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
)
insert into maps (
    "name", 
    "type", 
    "active_pool", 
    "workshop_map_id", 
    "poster", 
    "patch", 
    "label"
)
SELECT 
    name,
    type,
    active_pool,
    workshop_map_id,
    poster,
    patch,
    label
FROM all_maps
on conflict("name", "type") do update set 
    "active_pool" = EXCLUDED."active_pool", 
    "workshop_map_id" = EXCLUDED."workshop_map_id", 
    "poster" = EXCLUDED."poster", 
    "patch" = EXCLUDED."patch", 
    "label" = EXCLUDED."label";

insert into e_map_pool_types ("value", "description") values
    ('Competitive', '5 vs 5'),
    ('Wingman', '2 vs 2'),
    ('Duel', '1 vs 1'),
    ('Custom', 'Custom')
on conflict(value) do update set "description" = EXCLUDED."description";

-- create seed map pools
WITH new_rows AS (
  SELECT *
  FROM (VALUES
      ('Competitive', true, true),
      ('Wingman', true, true),
      ('Duel', true, true)
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

create or replace function update_map_pools()
returns boolean as $$
declare
    update_map_pools text;
begin
    SELECT value INTO update_map_pools FROM settings WHERE name = 'update_map_pools';

    IF NOT FOUND OR update_map_pools = '' THEN
        update_map_pools := 'true';
    END IF;

    if(select COUNT(*) from _map_pool) = 0 then 
        update_map_pools = 'true';
    end if;

    if(update_map_pools = 'true') then
        DELETE FROM _map_pool
        WHERE map_pool_id IN (
            SELECT id FROM map_pools WHERE type IN ('Competitive', 'Wingman', 'Duel')
        );
        
        WITH pool_ids AS (
            SELECT id, type
            FROM map_pools
            WHERE type IN ('Competitive', 'Wingman', 'Duel')
            ORDER BY type
        )
        INSERT INTO _map_pool (map_id, map_pool_id)
        SELECT m.id, p.id
        FROM maps m
        JOIN pool_ids p ON (
            (p.type = 'Competitive' AND m.type = 'Competitive' AND m.active_pool = 'true') OR
            (p.type = 'Wingman' AND m.type = 'Wingman' AND m.active_pool = 'true') OR
            (p.type = 'Duel' AND m.type = 'Duel' AND m.active_pool = 'true')
        )
        ON CONFLICT DO NOTHING;
        
        return true;
    end if;
    
    return false;
end;
$$ language plpgsql;

DO $$
BEGIN
    PERFORM update_map_pools();
END;
$$;
