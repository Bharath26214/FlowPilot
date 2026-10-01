/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { casesSchema } from './schemas/cases-schema'
import { evidenceSchema } from './schemas/evidence-schema'
import { findingsSchema } from './schemas/findings-schema'
import { reportsSchema } from './schemas/reports-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  casesSchema,
  evidenceSchema,
  findingsSchema,
  reportsSchema,
]
