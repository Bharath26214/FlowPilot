import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

/** Investigator decisions on findings. Append-only; written only by `reviewFinding`. */
export const reviewsSchema: CollectionSchema = {
  name: 'reviews',
  columns: [
    { name: 'caseId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'findingId', storage: 'text', interpretation: 'plain', required: true },
    {
      name: 'decision',
      storage: 'text',
      interpretation: { kind: 'select', options: ['investigating', 'accepted', 'dismissed'] },
      required: true,
    },
    { name: 'note', storage: 'text', interpretation: 'plain' },
    { name: 'reviewer', storage: 'text', interpretation: 'plain', required: true },
    { name: 'decidedAt', storage: 'text', interpretation: 'plain', required: true },
    { name: 'confidenceShown', storage: 'number', interpretation: 'plain' },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
