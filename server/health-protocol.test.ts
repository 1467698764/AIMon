import { describe, expect, it } from 'vitest'
import { extractGeneratedText, extractSseText, sseLinesContainGeneratedText } from './health-protocol.js'

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

describe('reply extraction for custom-prompt checks', () => {
  it('reads text from chat, responses, anthropic and gemini payloads', () => {
    expect(extractGeneratedText({ choices: [{ message: { content: '答案是 20' } }] })).toBe('答案是 20')
    expect(extractGeneratedText({ output: [{ content: [{ text: '答案是 20' }] }] })).toBe('答案是 20')
    expect(extractGeneratedText({ content: [{ text: '答' }, { text: '案' }] })).toBe('答案')
    expect(extractGeneratedText({ candidates: [{ content: { parts: [{ text: '答案是 20' }] } }] })).toBe('答案是 20')
    expect(extractGeneratedText({ error: { message: 'nope' } })).toBe('')
  })

  it('concatenates streamed deltas and never doubles a repeated snapshot', () => {
    expect(extractSseText([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{"content":"是 20"}}]}',
      'data: [DONE]',
    ].join('\n'))).toBe('答案是 20')
    expect(extractSseText([
      'data: {"type":"response.output_text.delta","delta":"答案"}',
      'data: {"type":"response.output_text.done","text":"答案"}',
    ].join('\n'))).toBe('答案')
  })
})
