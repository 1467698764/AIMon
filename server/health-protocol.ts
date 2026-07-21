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
