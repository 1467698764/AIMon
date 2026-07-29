export function hasGeneratedText(value: any): boolean {
  if (!value || typeof value !== 'object') return false
  const candidates = [
    value.output_text,
    value.text,
    value.content,
    value.choices?.[0]?.delta?.content,
    value.choices?.[0]?.message?.content,
  ]
  if (candidates.some((item) => typeof item === 'string' && item.trim())) return true
  if (typeof value.delta === 'string' && value.delta.trim()) {
    const eventType = typeof value.type === 'string' ? value.type : ''
    if (!eventType || /(?:output_)?text.*delta|delta.*(?:output_)?text/i.test(eventType)) return true
  }
  if (!Array.isArray(value.output)) return false
  return value.output.some((item: any) => Array.isArray(item?.content)
    && item.content.some((content: any) => {
      const text = content?.text || content?.output_text
      return typeof text === 'string' && text.trim()
    }))
}

export function sseLinesContainGeneratedText(lines: string[]): boolean {
  return lines.some((line) => {
    const data = line.match(/^data:\s*(.+)$/i)?.[1]?.trim()
    if (!data || data === '[DONE]') return false
    try {
      return hasGeneratedText(JSON.parse(data))
    } catch {
      return false
    }
  })
}

function joinTextParts(parts: any[]): string {
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part?.output_text === 'string' ? part.output_text : ''))
    .join('')
    .trim()
}

/**
 * The reply a custom-prompt check has to display. Deliberately a superset of
 * hasGeneratedText: the pass/fail verdict must not shift just because a payload
 * shape is only understood well enough to quote it back to the user.
 */
export function extractGeneratedText(value: any): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  const candidates = [
    value.output_text,
    value.choices?.[0]?.delta?.content,
    value.choices?.[0]?.message?.content,
    value.content,
    value.delta?.text,
    value.text,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (Array.isArray(candidate)) {
      const joined = joinTextParts(candidate)
      if (joined) return joined
    }
  }
  if (typeof value.delta === 'string' && value.delta.trim()) {
    const eventType = typeof value.type === 'string' ? value.type : ''
    if (!eventType || /(?:output_)?text.*delta|delta.*(?:output_)?text/i.test(eventType)) return value.delta
  }
  if (Array.isArray(value.output)) {
    const joined = joinTextParts(value.output.flatMap((item: any) => (Array.isArray(item?.content) ? item.content : [])))
    if (joined) return joined
  }
  if (Array.isArray(value.candidates)) {
    const joined = joinTextParts(value.candidates.flatMap((item: any) => (Array.isArray(item?.content?.parts) ? item.content.parts : [])))
    if (joined) return joined
  }
  return ''
}

// Incremental events concatenate; snapshot events replace, so a stream that
// repeats its full text in a terminal event is not quoted back twice.
function isIncrementalEvent(event: any): boolean {
  return typeof event?.choices?.[0]?.delta?.content === 'string'
    || typeof event?.delta === 'string'
    || typeof event?.delta?.text === 'string'
}

export function extractSseText(body: string): string {
  let streamed = ''
  let snapshot = ''
  for (const line of body.split(/\r?\n/)) {
    const data = line.match(/^data:\s*(.+)$/i)?.[1]?.trim()
    if (!data || data === '[DONE]') continue
    let event: any
    try { event = JSON.parse(data) } catch { continue }
    const text = extractGeneratedText(event)
    if (!text) continue
    if (isIncrementalEvent(event)) streamed += text
    else if (text.length > snapshot.length) snapshot = text
  }
  return (streamed.length >= snapshot.length ? streamed : snapshot).trim()
}
