import { getAuthToken } from 'deepspace'

export async function callAction<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in required')

  const res = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  })

  let body: { success?: boolean; data?: T; error?: string } = {}
  try {
    body = (await res.json()) as { success?: boolean; data?: T; error?: string }
  } catch {
    body = {}
  }

  if (!res.ok || body.success === false) {
    throw new Error(body.error || `Request failed (${res.status})`)
  }
  return body.data as T
}
