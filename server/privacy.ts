const REDACTED = '[已隐藏]'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function collectValues(value: unknown, values: string[], seen: Set<unknown>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === 'string'
      && /^(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)$/i.test(key)
      && child.length >= 3
    ) {
      values.push(child)
    } else {
      collectValues(child, values, seen)
    }
  }
}

export function sensitiveValues(value: unknown): string[] {
  const values: string[] = []
  collectValues(value, values, new Set())
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

export function redactSensitiveText(value: unknown, explicitSecrets: Array<string | null | undefined> = []): string {
  let text = errorText(value)
  const secrets = [...new Set(explicitSecrets.filter((secret): secret is string => Boolean(secret && secret.length >= 3)))]
    .sort((a, b) => b.length - a.length)
  for (const secret of secrets) text = text.split(secret).join(REDACTED)

  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,}\b/g, REDACTED)
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      `$1${REDACTED}`,
    )
}

export function redactError(error: unknown, explicitSecrets: Array<string | null | undefined> = []): Error {
  return new Error(redactSensitiveText(error, explicitSecrets))
}
