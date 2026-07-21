const aliases: Record<string, string> = {
  'openai-response-compact': 'openai-response',
  responses: 'openai-response',
  embedding: 'embeddings',
  rerank: 'jina-rerank',
  image: 'image-generation',
}

export function endpointTypesForModel(name: string, rawTypes: unknown): string[] {
  const declared = Array.isArray(rawTypes)
    ? rawTypes.map((value) => aliases[String(value).toLowerCase()] || String(value).toLowerCase())
    : []
  if (declared.length) return [...new Set(declared)]

  if (/rerank|reranker/i.test(name)) return ['jina-rerank']
  if (/embedding|(?:^|[-_.])embed(?:[-_.]|$)|bge-m3|e5-(?:base|large|small)/i.test(name)) return ['embeddings']
  if (/dall-e|gpt-image|imagen|stable-diffusion|sdxl|flux(?:-|$)/i.test(name)) return ['image-generation']
  return ['openai']
}
