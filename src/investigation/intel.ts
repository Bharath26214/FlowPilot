/**
 * Threat-intel lookup helpers (Exa web search).
 *
 * Only IP addresses ever leave the app — never account names or emails, which
 * would disclose who is under investigation to a third party. Results are
 * external, unverified context: the UI and the assistant both treat them as
 * a basis for inference, never as evidence.
 */

export type IntelResult = { title: string; url: string; publishedDate: string | null; snippet: string }

const MAX_IPS = 3
const SNIPPET_CHARS = 360

/** Public IPv4/IPv6 addresses worth searching: private, loopback, and link-local ranges are skipped. */
export function searchableIps(ips: string[]): string[] {
  const out: string[] = []
  for (const raw of ips) {
    const ip = raw.trim()
    if (!ip || out.includes(ip) || !isPublic(ip)) continue
    out.push(ip)
    if (out.length === MAX_IPS) break
  }
  return out
}

function isPublic(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (v4.slice(1).some((part) => Number(part) > 255)) return false
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
    if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
    return true
  }
  if (!ip.includes(':') || !/^[0-9a-f:]+$/i.test(ip)) return false
  const lower = ip.toLowerCase()
  return !(lower === '::1' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd'))
}

export function intelQuery(ip: string): Record<string, unknown> {
  return {
    query: `"${ip}" IP address abuse report malicious activity`,
    numResults: 5,
    contents: {
      highlights: {
        numSentences: 2,
        highlightsPerUrl: 1,
        query: `Is ${ip} associated with malicious activity, abuse, Tor, VPN, or hosting?`,
      },
    },
  }
}

/** Keeps only what the UI and assistant need from an Exa response, trimmed. */
export function normalizeIntel(data: unknown): IntelResult[] {
  const results = (data as { results?: unknown })?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((item): IntelResult[] => {
    const row = item as Record<string, unknown>
    if (typeof row.url !== 'string' || !/^https?:\/\//.test(row.url)) return []
    const highlight = Array.isArray(row.highlights) ? row.highlights.filter((h) => typeof h === 'string').join(' … ') : ''
    return [
      {
        title: typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 200) : row.url,
        url: row.url,
        publishedDate: typeof row.publishedDate === 'string' ? row.publishedDate : null,
        snippet: clean(highlight).slice(0, SNIPPET_CHARS),
      },
    ]
  })
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/(\.\.\.\s*)+/g, '… ').trim()
}
