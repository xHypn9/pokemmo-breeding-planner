PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pokemon_species (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  egg_groups_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pokemon_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
  gender TEXT NOT NULL CHECK (gender IN ('Male','Female','Genderless')),
  hp INTEGER NOT NULL CHECK (hp BETWEEN 0 AND 31),
  atk INTEGER NOT NULL CHECK (atk BETWEEN 0 AND 31),
  def INTEGER NOT NULL CHECK (def BETWEEN 0 AND 31),
  sp_atk INTEGER NOT NULL CHECK (sp_atk BETWEEN 0 AND 31),
  sp_def INTEGER NOT NULL CHECK (sp_def BETWEEN 0 AND 31),
  speed INTEGER NOT NULL CHECK (speed BETWEEN 0 AND 31),
  nature TEXT NOT NULL,
  alpha INTEGER NOT NULL CHECK (alpha IN (0,1)),
  ha INTEGER NOT NULL CHECK (ha IN (0,1)),
  box_id INTEGER REFERENCES boxes(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('Available','Reserved','Consumed')) DEFAULT 'Available',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS breeding_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Draft','Calculating','Ready','In Progress','Completed','Invalidated')),
  target_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS breeding_plan_nodes (
  plan_id INTEGER NOT NULL REFERENCES breeding_plans(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (plan_id, node_id)
);

CREATE TABLE IF NOT EXISTS breeding_plan_steps (
  plan_id INTEGER NOT NULL REFERENCES breeding_plans(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (plan_id, step_id)
);

CREATE TABLE IF NOT EXISTS breeding_plan_edges (
  plan_id INTEGER NOT NULL REFERENCES breeding_plans(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, source_node_id, target_node_id)
);

CREATE TABLE IF NOT EXISTS missing_breeders (
  plan_id INTEGER NOT NULL REFERENCES breeding_plans(id) ON DELETE CASCADE,
  missing_id TEXT NOT NULL,
  constraint_json TEXT NOT NULL,
  replaced_inventory_id INTEGER REFERENCES pokemon_inventory(id),
  PRIMARY KEY (plan_id, missing_id)
);

CREATE TABLE IF NOT EXISTS operation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_species ON pokemon_inventory(species_id);
CREATE INDEX IF NOT EXISTS idx_inventory_box ON pokemon_inventory(box_id);
CREATE INDEX IF NOT EXISTS idx_inventory_status ON pokemon_inventory(status);
CREATE INDEX IF NOT EXISTS idx_inventory_traits ON pokemon_inventory(alpha, ha, gender, nature);
CREATE INDEX IF NOT EXISTS idx_inventory_ivs ON pokemon_inventory(hp, atk, def, sp_atk, sp_def, speed);
CREATE INDEX IF NOT EXISTS idx_plans_status ON breeding_plans(status);
CREATE INDEX IF NOT EXISTS idx_steps_order ON breeding_plan_steps(plan_id, step_order);
CREATE INDEX IF NOT EXISTS idx_history_created ON operation_history(created_at DESC);
