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

-- Valve will add and remove workshop maps from the game, so we need to update the maps table accordingly
update maps 
   set "name" = 'de_grail', "workshop_map_id" = null
   where "workshop_map_id" = '3246527710';

update maps 
   set "name" = 'de_jura', "workshop_map_id" = null
   where "workshop_map_id" = '3261289969';

update maps 
   set "name" = 'de_brewery', "workshop_map_id" = null
   where "workshop_map_id" = '3070290240';

update maps 
   set "name" = 'de_dogtown', "workshop_map_id" = null
   where "workshop_map_id" = '3273728973';

insert into maps ("name", "type", "active_pool", "workshop_map_id", "poster", "patch", "label") values
    --  Valve Competitive
    ('de_ancient', 'Competitive', 'true',  null, '/img/maps/screenshots/de_ancient.webp', '/img/maps/icons/de_ancient.svg', null),
    ('de_anubis', 'Competitive', 'false',  null, '/img/maps/screenshots/de_anubis.webp', '/img/maps/icons/de_anubis.svg', null),
    ('de_inferno', 'Competitive', 'true',  null, '/img/maps/screenshots/de_inferno.webp', '/img/maps/icons/de_inferno.svg', null),
    ('de_mirage', 'Competitive', 'true',  null, '/img/maps/screenshots/de_mirage.webp', '/img/maps/icons/de_mirage.svg', null),
    ('de_nuke', 'Competitive', 'true',  null, '/img/maps/screenshots/de_nuke.webp', '/img/maps/icons/de_nuke.svg', null),
    ('de_overpass', 'Competitive', 'true',  null, '/img/maps/screenshots/de_overpass.webp', '/img/maps/icons/de_overpass.svg', null),
    ('de_vertigo', 'Competitive', 'false',  null, '/img/maps/screenshots/de_vertigo.webp', '/img/maps/icons/de_vertigo.svg', null),
    ('de_dust2', 'Competitive', 'true',  null, '/img/maps/screenshots/de_dust2.webp', '/img/maps/icons/de_dust2.svg', null),
    ('de_train', 'Competitive', 'true',  null, '/img/maps/screenshots/de_train.webp', '/img/maps/icons/de_train.svg', null),

    -- Workshop Competitive
    ('de_cache', 'Competitive', 'false',  '3437809122', '/img/maps/screenshots/de_cache.webp', '/img/maps/icons/de_cache.svg', null),
    ('de_thera', 'Competitive', 'false',  '3121217565', '/img/maps/screenshots/de_thera.webp', '/img/maps/icons/de_thera.svg', null),
    ('de_mills', 'Competitive', 'false',  '3152430710', '/img/maps/screenshots/de_mills.webp', '/img/maps/icons/de_mills.svg', null),    
    ('de_edin', 'Competitive', 'false',  '3328169568', '/img/maps/screenshots/de_edin.webp', '/img/maps/icons/de_edin.svg', null),
    ('de_basalt', 'Competitive', 'false',  '3329258290', '/img/maps/screenshots/de_basalt.webp', '/img/maps/icons/de_basalt.svg', null),
    ('de_grail', 'Competitive', 'true',  null, '/img/maps/screenshots/de_grail.webp', '/img/maps/icons/de_grail.svg', null),
    ('de_jura', 'Competitive', 'true',  null, '/img/maps/screenshots/de_jura.webp', '/img/maps/icons/de_jura.svg', null),

    -- Valve Wingman
    ('de_inferno', 'Wingman', 'true',  null, '/img/maps/screenshots/de_inferno.webp', '/img/maps/icons/de_inferno.svg', null),
    ('de_nuke', 'Wingman', 'true',  null, '/img/maps/screenshots/de_nuke.webp', '/img/maps/icons/de_nuke.svg', null),
    ('de_overpass', 'Wingman', 'true',  null, '/img/maps/screenshots/de_overpass.webp', '/img/maps/icons/de_overpass.svg', null),
    ('de_vertigo', 'Wingman', 'true',  null, '/img/maps/screenshots/de_vertigo.webp', '/img/maps/icons/de_vertigo.svg', null),

    --  Workshop Wingman
    ('de_brewery', 'Wingman', 'true',  null, '/img/maps/screenshots/de_brewery.webp', '/img/maps/icons/de_brewery.svg', null),
    ('de_assembly', 'Wingman', 'false',  '3071005299', '/img/maps/screenshots/de_assembly.webp', '/img/maps/icons/de_assembly.svg', null),
    ('de_memento', 'Wingman', 'false',  '3165559377', '/img/maps/screenshots/de_memento.webp', '/img/maps/icons/de_memento.svg', null),
    ('de_palais', 'Wingman', 'false',  '2891200262', '/img/maps/screenshots/de_palais.webp', '/img/maps/icons/de_palais.svg', null),
    ('de_whistle', 'Wingman', 'false',  '3308613773', '/img/maps/screenshots/de_whistle.webp', '/img/maps/icons/de_whistle.svg', null),
    ('de_dogtown', 'Wingman', 'true', null, '/img/maps/screenshots/de_dogtown.webp', '/img/maps/icons/de_dogtown.svg', null),

    -- Vavle Wingman
    ('de_inferno', 'Duel', 'true',  null, '/img/maps/screenshots/de_inferno.webp', '/img/maps/icons/de_inferno.svg', null),
    ('de_nuke', 'Duel', 'true',  null, '/img/maps/screenshots/de_nuke.webp', '/img/maps/icons/de_nuke.svg', null),
    ('de_overpass', 'Duel', 'true',  null, '/img/maps/screenshots/de_overpass.webp', '/img/maps/icons/de_overpass.svg', null),
    ('de_vertigo', 'Duel', 'true',  null, '/img/maps/screenshots/de_vertigo.webp', '/img/maps/icons/de_vertigo.svg', null),

    --  Workshop Duel
    ('de_brewery', 'Duel', 'true',  null, '/img/maps/screenshots/de_brewery.webp', '/img/maps/icons/de_brewery.svg', null),
    ('de_assembly', 'Duel', 'false',  '3071005299', '/img/maps/screenshots/de_assembly.webp', '/img/maps/icons/de_assembly.svg', null),
    ('de_memento', 'Duel', 'false',  '3165559377', '/img/maps/screenshots/de_memento.webp', '/img/maps/icons/de_memento.svg', null),
    ('de_palais', 'Duel', 'false',  '2891200262', '/img/maps/screenshots/de_palais.webp', '/img/maps/icons/de_palais.svg', null),
    ('de_whistle', 'Duel', 'false',  '3308613773', '/img/maps/screenshots/de_whistle.webp', '/img/maps/icons/de_whistle.svg', null),
    ('de_dogtown', 'Duel', 'true', null, '/img/maps/screenshots/de_dogtown.webp', '/img/maps/icons/de_dogtown.svg', null)
    

on conflict(name, type) do update set "active_pool" = EXCLUDED."active_pool", "workshop_map_id" = EXCLUDED."workshop_map_id", "poster" = EXCLUDED."poster", "patch" = EXCLUDED."patch", "label" = EXCLUDED."label";

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
    select COALESCE(value, 'false') into update_map_pools from settings where name = 'update_map_pools';

    if(select COUNT(*) from _map_pool) = 0 then 
        update_map_pools = 'true';
    end if;

    if(update_map_pools = 'true') then
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
