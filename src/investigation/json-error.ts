/**
 * Locates the first syntax error in invalid JSON. `JSON.parse` messages differ
 * between runtimes and some carry no position at all, so the analyzer scans
 * the text itself to tell an investigator exactly where a file breaks.
 */
export type JsonError = { offset: number; line: number; column: number; reason: string }

export function findJsonError(text: string): JsonError | null {
  let i = 0
  const fail = (reason: string): never => {
    throw Object.assign(new Error(reason), { offset: i })
  }
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1
  }
  const expect = (char: string, what: string) => {
    ws()
    if (text[i] !== char) fail(i >= text.length ? `the file ends before ${what}` : `expected ${what} but found ${describe(text[i])}`)
    i += 1
  }
  const string = () => {
    i += 1
    while (i < text.length) {
      const char = text[i]
      if (char === '"') {
        i += 1
        return
      }
      if (char === '\\') {
        const next = text[i + 1]
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('invalid \\u escape in a string')
          i += 6
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) i += 2
        else fail('invalid escape in a string')
        continue
      }
      if (char < ' ') fail('unescaped control character in a string')
      i += 1
    }
    fail('the file ends inside a string')
  }
  const value = (): void => {
    ws()
    const char = text[i]
    if (char === undefined) fail('the file ends where a value was expected')
    if (char === '{') {
      i += 1
      ws()
      if (text[i] === '}') {
        i += 1
        return
      }
      for (;;) {
        ws()
        if (text[i] !== '"') fail(text[i] === '}' ? 'trailing comma before }' : i >= text.length ? 'the file ends inside an object' : `expected a quoted key but found ${describe(text[i])}`)
        string()
        expect(':', '":"')
        value()
        ws()
        if (text[i] === ',') {
          i += 1
          continue
        }
        expect('}', '"," or "}"')
        return
      }
    }
    if (char === '[') {
      i += 1
      ws()
      if (text[i] === ']') {
        i += 1
        return
      }
      for (;;) {
        ws()
        if (text[i] === ']') fail('trailing comma before ]')
        value()
        ws()
        if (text[i] === ',') {
          i += 1
          continue
        }
        expect(']', '"," or "]"')
        return
      }
    }
    if (char === '"') return string()
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64))
    if (!literal) fail(`unexpected ${describe(char)}`)
    i += literal![0].length
  }

  try {
    value()
    ws()
    if (i < text.length) fail(`unexpected ${describe(text[i])} after the end of the JSON`)
    return null
  } catch (err) {
    const offset = (err as { offset?: number }).offset ?? i
    const before = text.slice(0, offset).split('\n')
    return { offset, line: before.length, column: before[before.length - 1].length + 1, reason: (err as Error).message }
  }
}

function describe(char: string | undefined): string {
  if (char === undefined) return 'the end of the file'
  if (char === '\n') return 'a line break'
  return `"${char}"`
}
