import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

/** External web results for a finding's IPs (Exa). Unverified context, never evidence. */
export const intelSchema: CollectionSchema = {
  name: 'intel',
  columns: [
    { name: 'caseId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'findingId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'indicator', storage: 'text', interpretation: 'plain', required: true },
    { name: 'results', storage: 'text', interpretation: { kind: 'json' }, required: true },
    { name: 'lookedUpBy', storage: 'text', interpretation: 'plain' },
    { name: 'lookedUpAt', storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
