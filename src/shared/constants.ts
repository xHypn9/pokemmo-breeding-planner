export const STATS = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed'] as const
export const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'
] as const

export const APP_SCHEMA_VERSION = 2
export const RULESET_VERSION = 'pokemmo-v1-2026-08-23'
export const PLANNER_MAX_STATES = 32_000
