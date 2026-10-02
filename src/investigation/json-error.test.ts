import { describe, expect, it } from 'vitest'
import { findJsonError } from './json-error'

describe('findJsonError', () => {
  it('accepts valid JSON', () => {
    for (const text of ['[]', '{}', '[1, -2.5e3, "a\\u00e9", true, null, {"k": [ ]}]', ' {"a":"b"} ']) expect(findJsonError(text)).toBeNull()
  })

  it.each([
    ['[1, 2', 'the file ends before "," or "]"', 1, 6],
    ['{"a": 1,}', 'trailing comma before }', 1, 9],
    ['{a: 1}', 'expected a quoted key but found "a"', 1, 2],
    ['[1]\n[2]', 'unexpected "[" after the end of the JSON', 2, 1],
    ['["a\nb"]', 'unescaped control character in a string', 1, 4],
    ['{"a" 1}', 'expected ":" but found "1"', 1, 6],
  ])('locates %j', (text, reason, line, column) => {
    expect(findJsonError(text)).toMatchObject({ reason, line, column })
  })
})
