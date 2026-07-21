import { describe, expect, it } from 'vitest'
import { sseLinesContainGeneratedText } from './health-protocol.js'

describe('streaming TTFT token detection', () => {
  it('ignores stream metadata, role deltas, done markers, and empty text', () => {
    expect(sseLinesContainGeneratedText([
      'event: response.created',
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"   "}}]}',
      'data: {"type":"response.function_call_arguments.delta","delta":"{"}',
      'data: [DONE]',
    ])).toBe(false)
  })

  it('recognizes the first non-empty streamed text token', () => {
    expect(sseLinesContainGeneratedText([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"O"}}]}',
    ])).toBe(true)
  })

  it('supports Responses API text delta events without treating malformed data as text', () => {
    expect(sseLinesContainGeneratedText([
      'data: not-json',
      'data: {"type":"response.output_text.delta","delta":"OK"}',
    ])).toBe(true)
  })
})
