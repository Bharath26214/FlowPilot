import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

export const evidenceSchema: CollectionSchema = {
  name: 'evidence',
  columns: [
    { name: 'caseId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fileName', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fileKey', storage: 'text', interpretation: 'plain' },
    { name: 'byteSize', storage: 'number', interpretation: 'plain' },
    { name: 'sha256', storage: 'text', interpretation: 'plain' },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['stored'] },
      required: true,
    },
    {
      name: 'analysisStatus',
      storage: 'text',
      interpretation: { kind: 'select', options: ['pending', 'running', 'complete', 'failed'] },
      required: true,
    },
    { name: 'analysisSummary', storage: 'text', interpretation: 'plain' },
    { name: 'eventCount', storage: 'number', interpretation: 'plain' },
    { name: 'signals', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'content', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
