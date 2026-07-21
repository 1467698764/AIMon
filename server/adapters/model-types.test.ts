import { describe, expect, it } from 'vitest'
import { endpointTypesForModel } from './model-types.js'

describe('model endpoint type normalization', () => {
  it('normalizes declared aliases from modified relay sites', () => {
    expect(endpointTypesForModel('gpt-5', ['openai-response-compact'])).toEqual(['openai-response'])
    expect(endpointTypesForModel('custom', ['embedding'])).toEqual(['embeddings'])
  })

  it('infers common non-chat model families when metadata is absent', () => {
    expect(endpointTypesForModel('text-embedding-3-large', [])).toEqual(['embeddings'])
    expect(endpointTypesForModel('bge-reranker-v2-m3', [])).toEqual(['jina-rerank'])
    expect(endpointTypesForModel('gpt-image-1', [])).toEqual(['image-generation'])
    expect(endpointTypesForModel('claude-sonnet-4-5', [])).toEqual(['openai'])
  })
})
