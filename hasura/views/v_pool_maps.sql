CREATE OR REPLACE VIEW public.v_pool_maps AS
 SELECT _map_pool.map_pool_id,
    maps.id,
    maps.name,
    maps.type,
    maps.poster,
    maps.patch,
    maps.active_pool,
    maps.workshop_map_id
   FROM (public._map_pool
     LEFT JOIN public.maps ON ((_map_pool.map_id = maps.id)));