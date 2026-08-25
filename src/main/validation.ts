import { z } from 'zod'
import { NATURES, STATS } from '../shared/constants'

const iv = z.number().int().min(0).max(31)
export const ivsSchema = z.object({ hp: iv, atk: iv, def: iv, spAtk: iv, spDef: iv, speed: iv })
export const inventorySchema = z.object({
  speciesId: z.number().int().positive(), gender: z.enum(['Male', 'Female', 'Genderless']), ivs: ivsSchema,
  nature: z.enum(NATURES), alpha: z.boolean(), ha: z.boolean(), boxId: z.number().int().positive().nullable(),
  notes: z.string().max(2_000), status: z.enum(['Available', 'Reserved', 'Consumed']).optional(), breedingEnabled: z.boolean().optional()
})
export const inventoryPatchSchema = inventorySchema.partial()
export const filtersSchema = z.object({
  status: z.enum(['Available', 'Reserved', 'Consumed']).optional(), breedingEnabled: z.boolean().optional(), speciesId: z.number().int().positive().optional(),
  boxId: z.number().int().positive().optional(), gender: z.enum(['Male', 'Female', 'Genderless']).optional(),
  alpha: z.boolean().optional(), ha: z.boolean().optional(), nature: z.enum(NATURES).optional(),
  query: z.string().max(100).optional(), eggGroup: z.string().max(40).optional(), iv31: z.array(z.enum(STATS)).max(6).optional()
}).strict()
export const completeStepSchema = z.object({
  planId: z.number().int().positive(), stepId: z.string().min(1).max(100), observedIvs: ivsSchema.partial().optional(), observedNature: z.enum(NATURES).optional()
})
export const idSchema = z.number().int().positive()
export const pathSchema = z.string().min(1).max(32_768)

const normalizedRoiSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1)
}).refine((roi) => roi.x + roi.width <= 1.001 && roi.y + roi.height <= 1.001, 'ROI must fit inside the captured window')
export const scannerCalibrationSchema = z.object({
  version: z.number().int().positive(),
  autoDetectBox: z.boolean().optional(),
  rois: z.object({
    species: normalizedRoiSchema, gender: normalizedRoiSchema, ivs: normalizedRoiSchema, nature: normalizedRoiSchema,
    alpha: normalizedRoiSchema, ha: normalizedRoiSchema, fingerprint: normalizedRoiSchema
  }),
  thresholds: z.object({
    verified: z.number().min(0.5).max(1), error: z.number().min(0).max(0.95),
    alphaColorRatio: z.number().positive().max(0.5), haColorRatio: z.number().positive().max(0.5), genderColorRatio: z.number().positive().max(0.5)
  }).refine((value) => value.error < value.verified, 'Error confidence must be lower than verified confidence'),
  stableFrames: z.number().int().min(2).max(10), pollIntervalMs: z.number().int().min(120).max(2_000)
})
export const scannerScanRequestSchema = z.object({
  sourceId: z.string().min(1).max(300), calibration: scannerCalibrationSchema,
  includeCrops: z.boolean().optional(), debugSave: z.boolean().optional()
})
export const scannerHotkeySchema = scannerScanRequestSchema.extend({
  enabled: z.boolean(), accelerator: z.string().trim().min(1).max(80)
})
