/**
 * Live smoke test: two turns on one dsh session against a real remote Hermes.
 * The second turn must answer from the first one's context (--resume works).
 *
 *   node tools/smoke-remote.mjs [sshHost] [sshUser]
 *
 * Run it from a normal terminal: it spawns ssh with piped stdio, which dsh's
 * tool sandbox does not allow.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HermesAdapter } from '../lib/index.js'

const host = process.argv[2] ?? process.env.HERMES_SSH_HOST
if (!host) throw new Error('Set HERMES_SSH_HOST or pass an SSH host as the first argument.')
const user = process.argv[3] ?? process.env.HERMES_SSH_USER ?? ''
const command = process.env.HERMES_COMMAND ?? 'hermes'
const provider = 'hermes-remote'

const adapter = new HermesAdapter(
  {
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
    logger: (ns) => console.error(`[${ns}]`),
  },
  {
    hosts: [{ id: provider, name: 'Remote Hermes', sshHost: host, sshUser: user, command, remoteCwd: process.env.HERMES_REMOTE_CWD ?? '' }],
    models: [{ id: 'hermes', name: 'Remote default' }],
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-smoke-')),
    debug: true,
  },
)

const messages = [{ role: 'user', content: [{ type: 'text', text: 'Remember the word PLUM. Reply with exactly: R1' }] }]

const turn = async (label, msgs) => {
  const started = Date.now()
  let text = ''
  let usage
  let finish
  const blocks = []
  const iterator = adapter.stream(provider, { sessionId: 'smoke', model: 'hermes', messages: msgs })
  for await (const chunk of iterator) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'block-end') blocks.push(`${chunk.block.type}:${chunk.block.text.length}`)
  }
  console.log(`\n[${label}] ${Date.now() - started}ms blocks=[${blocks.join(', ')}]`)
  console.log(`  text=${JSON.stringify(text)}`)
  console.log(`  usage=${JSON.stringify(usage)} finish=${JSON.stringify(finish)}`)
  return text
}

const first = await turn('turn 1', messages)
messages.push({ role: 'assistant', content: [{ type: 'text', text: first }] })
messages.push({ role: 'user', content: [{ type: 'text', text: 'Which word did I ask you to remember? Reply with just that word.' }] })
const second = await turn('turn 2', messages)

const ok = second.toUpperCase().includes('PLUM')
console.log(ok ? '\nRESUME OK' : '\nRESUME FAILED')
adapter.dispose()
process.exitCode = ok ? 0 : 1
