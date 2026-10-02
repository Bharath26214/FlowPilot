import type { CollectionSchema } from 'deepspace/schema'

const readOnly = { read: true, create: false, update: false, delete: false } as const

/** Assistant answers about a case. Written only by the `askAssistant` action. */
export const briefsSchema: CollectionSchema = {
  name: 'briefs',
  columns: [
    { name: 'caseId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'question', storage: 'text', interpretation: 'plain', required: true },
    { name: 'statements', storage: 'text', interpretation: { kind: 'json' }, required: true },
    { name: 'openQuestions', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'droppedCitations', storage: 'number', interpretation: 'plain' },
    { name: 'warning', storage: 'text', interpretation: 'plain' },
    { name: 'model', storage: 'text', interpretation: 'plain' },
    { name: 'askedBy', storage: 'text', interpretation: 'plain' },
    { name: 'askedAt', storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}
