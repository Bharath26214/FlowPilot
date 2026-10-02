/**
 * Renders the exported Markdown report as a print-ready HTML page for PDF
 * conversion. It understands only the subset `buildReport` emits — headings,
 * nested bullet lists, checklist items, and paragraphs — and escapes every
 * piece of text, since titles and notes can carry content from uploaded logs.
 */

export function reportHtml(markdown: string, caseNumber: string): string {
  const body: string[] = []
  let listDepth = 0
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0) body.push(`<p>${paragraph.map(escape).join('<br>')}</p>`)
    paragraph = []
  }
  const closeLists = (to: number) => {
    while (listDepth > to) {
      body.push('</ul>')
      listDepth -= 1
    }
  }

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const item = /^(\s*)-\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      closeLists(0)
      const level = heading[1].length
      body.push(`<h${level}>${escape(heading[2])}</h${level}>`)
    } else if (item) {
      flushParagraph()
      const depth = Math.floor(item[1].length / 2) + 1
      if (depth > listDepth) {
        while (listDepth < depth) {
          body.push('<ul>')
          listDepth += 1
        }
      } else {
        closeLists(depth)
      }
      const check = /^\[( |x)\]\s+(.*)$/.exec(item[2])
      body.push(
        check
          ? `<li class="check ${check[1] === 'x' ? 'yes' : 'no'}">${check[1] === 'x' ? '✓' : '–'} ${escape(check[2])}</li>`
          : `<li>${escape(item[2])}</li>`,
      )
    } else if (line.trim() === '') {
      flushParagraph()
      closeLists(0)
    } else {
      closeLists(0)
      paragraph.push(line)
    }
  }
  flushParagraph()
  closeLists(0)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(caseNumber)} — Investigation report</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1d21; }
  h1 { font-size: 20pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #d5d9de; }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; }
  p { margin: 0 0 6pt; }
  ul { margin: 0 0 6pt; padding-left: 16pt; }
  li { margin: 1pt 0; }
  li.check { list-style: none; margin-left: -12pt; }
  li.check.yes { color: #0f6b4a; }
  li.check.no { color: #8a9099; }
  .meta { color: #5c636c; font-size: 9pt; margin-bottom: 14pt; }
</style>
</head>
<body>
<p class="meta">FlowPilot investigation report · generated from confirmed findings only</p>
${body.join('\n')}
</body>
</html>
`
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** UTF-8 safe base64 for the Workers runtime (no Buffer). */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
