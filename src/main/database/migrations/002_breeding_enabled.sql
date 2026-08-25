ALTER TABLE pokemon_inventory
ADD COLUMN breeding_enabled INTEGER NOT NULL DEFAULT 1 CHECK (breeding_enabled IN (0,1));
