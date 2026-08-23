import type { BreedingTarget, PlanNode, Stat } from './types'

export interface ParsedTargetIvText {
  valid: boolean
  value: number | null
  exact: boolean
}

export function targetIvIsExact(target: BreedingTarget, stat: Stat): boolean {
  if (target.ivs[stat] === 31) return true
  return target.ivExact?.[stat] !== false
}

export function targetIvIsRequired(target: BreedingTarget, stat: Stat): boolean {
  const wanted = target.ivs[stat]
  // A minimum of zero accepts the full legal IV domain and therefore adds no constraint.
  return wanted !== null && (targetIvIsExact(target, stat) || wanted > 0)
}

export function targetIvMatchesValue(target: BreedingTarget, stat: Stat, value: number): boolean {
  const wanted = target.ivs[stat]
  if (wanted === null) return false
  return targetIvIsExact(target, stat) ? value === wanted : value >= wanted && value <= 31
}

export function nodeMeetsTargetIv(node: PlanNode, target: BreedingTarget, stat: Stat): boolean {
  if (!targetIvIsRequired(target, stat)) return false
  const possible = node.possibleIvs[stat]
  return possible.length > 0 && possible.every((value) => targetIvMatchesValue(target, stat, value))
}

export function targetIvLabel(target: BreedingTarget, stat: Stat): string {
  const value = target.ivs[stat]
  if (value === null) return 'IGNORE'
  return targetIvIsExact(target, stat) ? String(value) : `${value}+`
}

export function parseTargetIvText(raw: string): ParsedTargetIvText {
  const text = raw.trim()
  if (!text) return { valid: true, value: null, exact: true }
  const match = text.match(/^(\d{1,2})\s*(\+)?$/)
  if (!match) return { valid: false, value: null, exact: !text.endsWith('+') }
  const value = Number(match[1])
  if (!Number.isInteger(value) || value < 0 || value > 31) return { valid: false, value: null, exact: !match[2] }
  return { valid: true, value, exact: value === 31 }
}

export function normalizeTargetIvText(raw: string, exact: boolean): string {
  const parsed = parseTargetIvText(raw)
  if (!parsed.valid || parsed.value === null) return raw
  return exact || parsed.value === 31 ? String(parsed.value) : `${parsed.value}+`
}
