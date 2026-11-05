/**
 * Live check of the tool rows: ask the remote to actually run a shell command and print
 * the marked Markdown blocks the desktop renders, so the real hermes frame fields (input, output,
 * duration_ms, is_error) are verified against the formatter.
 *
 *   node tools/smoke-tools.mjs [sshHost] [sshUser] [model]
 *
 * Run it from a normal terminal: it spawns ssh with piped stdio.
 */
import assert from 'node:assert/strict'
import { TOOL_MARK } from '../lib/tool-display.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HermesAdapter } from '../lib/index.js'

const host = process.argv[2] ?? process.env.HERMES_SSH_HOST
if (!host) throw new Error('Set HERMES_SSH_HOST or pass an SSH host as the first argument.')
const user = process.argv[3] ?? process.env.HERMES_SSH_USER ?? ''
const model = process.argv[4] ?? ''
const provider = 'hermes-remote'

const adapter = new HermesAdapter(
  { llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} }, logger: () => () => {} },
  {
    hosts: [{
      id: provider,
      name: 'Remote Hermes',
      sshHost: host,
      sshUser: user,
      command: process.env.HERMES_COMMAND ?? 'hermes',
      remoteCwd: process.env.HERMES_REMOTE_CWD ?? '',
      models: [{ id: 'hermes', name: 'Remote default' }, { id: 'glm-5.3', hermesModel: 'glm-5.3' }],
    }],
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-tools-')),
    debug: true,
  },
)

const chunks = []
for await (const chunk of adapter.stream(provider, {
  sessionId: 'tools',
  model: model || 'hermes',
  messages: [{
    role: 'user',
    content: [{ type: 'text', text: 'Run this exact shell command and then reply with its output only: printf "HERMES_TOOL_LINE_1\\n  HERMES_TOOL_LINE_2\\n"' }],
  }],
})) {
  chunks.push(chunk)
}

const print = (label, body) => {
  console.log(`\n── ${label} ──`)
  console.log(body || '(empty)')
}

print('text lane', chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''))
print('reasoning lane (diagnostics only)', chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''))
const usage = chunks.find((c) => c.type === 'usage')
print('usage', usage ? JSON.stringify(usage.usage) : '(none)')
const finish = chunks.find((c) => c.type === 'finish')
print('finish', JSON.stringify(finish?.reason))
console.log('\ntool-call blocks emitted:', chunks.filter((c) => c.blockType === 'tool-call').length)
assert.equal(finish?.reason.kind, 'stop', JSON.stringify(finish?.reason))
const toolBlocks = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'text' && c.block.text.includes(TOOL_MARK))
assert.ok(toolBlocks.length >= 2, 'real remote call and result use marked Markdown')
assert.ok(toolBlocks.some((c) => c.block.text.includes('HERMES_TOOL_LINE_1\n  HERMES_TOOL_LINE_2')), 'real output keeps line breaks and indentation')
assert.equal(chunks.some((c) => c.blockType === 'tool-call'), false)
console.log('Live tool Markdown, multiline output, usage and successful completion verified.')
adapter.dispose()
