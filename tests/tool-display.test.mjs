import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_MARK, formatToolCall, formatToolResult, capToolBody } from '../lib/tool-display.js'

test('tool bodies preserve whitespace and declare truncation without flattening output', () => {
  assert.equal(capToolBody('one\r\n  two\tthree\r\nfour'), 'one\n  two\tthree\nfour')
  assert.match(capToolBody('1\n2\n3\n4', 2000, 2), /^1\n2\n…（另有 2 行未显示）$/)
  assert.match(capToolBody('123456\n789', 4), /^1234\n…（内容已截断）$/)
  assert.equal(capToolBody('\x1b[31merror\x1b[0m'), 'error')
})

test('commands use safe Markdown fences and escaped short titles while keeping the real command', () => {
  const command = 'echo one\nprintf "```"\necho two'
  const result = formatToolCall({ name: 'terminal', input: { command, description: '[test](https://example.test)\n# injected' } })
  assert.ok(result.startsWith(`\n\n${TOOL_MARK}执行`))
  assert.match(result, /\\\[test\\\]/)
  assert.ok(result.includes('````bash\n' + command))
  assert.ok(result.endsWith('````\n\n'))
  assert.equal(result.split('\n').filter((line) => line.startsWith('# injected')).length, 0)
})

test('result envelopes show both useful output and error, with status and elapsed time', () => {
  const result = formatToolResult({ name: 'terminal', duration_ms: 1234, output: JSON.stringify({ output: 'line1\nline2', error: 'failed', exit_code: 1 }) })
  assert.match(result, /失败 · 运行命令 · 1\.2 秒/)
  assert.ok(result.includes('line1\nline2\nfailed'))
  assert.doesNotMatch(result, /exit_code/)
  assert.match(formatToolResult({ name: 'read_file', output: '' }), /\(无输出\)/)
  assert.match(formatToolResult({ name: 'custom_tool', output: { answer: 42 }, is_error: true }), /失败 · custom\\_tool/)
})

test('tool summaries and bodies are redacted before display and bounded independently', () => {
  const options = { limit: 10, redact: (s) => s.replaceAll('PRIVATE', '[redacted]') }
  const call = formatToolCall({ name: 'terminal', input: { command: 'echo PRIVATE\nother' } }, options)
  const result = formatToolResult({ name: 'terminal', output: 'PRIVATE\nline2\nline3' }, options)
  assert.doesNotMatch(call + result, /PRIVATE/)
  assert.match(call + result, /内容已截断/)
})
