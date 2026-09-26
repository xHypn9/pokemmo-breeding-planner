UPDATE missing_breeders
SET replaced_inventory_id = NULL
WHERE replaced_inventory_id IN (SELECT id FROM pokemon_inventory WHERE status = 'Consumed');

DELETE FROM pokemon_inventory WHERE status = 'Consumed';
