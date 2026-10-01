import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

export const casesSchema: CollectionSchema = {
  name: 'cases',
  columns: [
    { name: 'caseNumber', storage: 'text', interpretation: 'plain', required: true },
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'summary', storage: 'text', interpretation: 'plain' },
    {
      name: 'stage',
      storage: 'text',
      interpretation: { kind: 'select', options: ['intake', 'evidence', 'analysis', 'findings', 'review', 'exported'] },
      required: true,
    },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
