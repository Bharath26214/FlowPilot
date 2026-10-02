import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

export const findingsSchema: CollectionSchema = {
  name: 'findings',
  columns: [
    { name: 'caseId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'evidenceId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'detail', storage: 'text', interpretation: 'plain' },
    {
      name: 'severity',
      storage: 'text',
      interpretation: { kind: 'select', options: ['low', 'medium', 'high'] },
      required: true,
    },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['draft', 'investigating', 'accepted', 'dismissed'] },
      required: true,
    },
    { name: 'indicator', storage: 'text', interpretation: 'plain', required: true },
    { name: 'hypothesis', storage: 'text', interpretation: 'plain' },
    { name: 'confidence', storage: 'number', interpretation: 'plain' },
    { name: 'factors', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'decidedBy', storage: 'text', interpretation: 'plain' },
    { name: 'decidedAt', storage: 'text', interpretation: 'plain' },
    { name: 'decisionNote', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
