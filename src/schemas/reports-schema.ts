import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

export const reportsSchema: CollectionSchema = {
  name: 'reports',
  columns: [
    { name: 'caseId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'body', storage: 'text', interpretation: 'plain', required: true },
    { name: 'exportedAt', storage: 'text', interpretation: 'plain', required: true },
    { name: 'pdfUrl', storage: 'text', interpretation: 'plain' },
    { name: 'pdfExpiresAt', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
