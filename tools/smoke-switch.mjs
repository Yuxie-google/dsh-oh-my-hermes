/**
 * Live check of the model switch: turn 1 runs the remote default model, turn 2
 * runs the same dsh session against another remote model. hermes refuses
 * `--resume` with a different `-m`, so the adapter must start a fresh remote
 * session carrying the transcript — the answer still has to remember turn 1.
 *
 *   node tools/smoke-switch.mjs [sshHost] [sshUser] [secondModel]
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
const other = process.argv[4] ?? process.env.HERMES_SECOND_MODEL ?? 'glm-5.3'
const provider = 'hermes-remote'

const adapter = new HermesAdapter(
  {
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
    logger: (ns) => console.error(`[${ns}]`),
  },
  {
    hosts: [{
      id: provider,
      name: 'Remote Hermes',
      sshHost: host,
      sshUser: user,
      command,
      remoteCwd: process.env.HERMES_REMOTE_CWD ?? '',
      models: [
        { id: 'hermes', name: 'Remote default' },
        { id: other, name: other, hermesModel: other },
      ],
    }],
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-switch-')),
    debug: true,
  },
)

const messages = [{ role: 'user', content: [{ type: 'text', text: 'Remember the word ORCHID. Reply with exactly: R1' }] }]

const turn = async (label, model, msgs) => {
  const started = Date.now()
  let text = ''
  let usage
  let finish
  for await (const chunk of adapter.stream(provider, { sessionId: 'switch', model, messages: msgs })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  console.log(`\n[${label} · model=${model}] ${Date.now() - started}ms`)
  console.log(`  text=${JSON.stringify(text.slice(0, 200))}`)
  console.log(`  usage=${JSON.stringify(usage)} finish=${JSON.stringify(finish)}`)
  console.log(`  stored=${JSON.stringify(adapter.storeFor(provider).get(`hermes-remote:switch`))}`)
  return text
}

const first = await turn('turn 1', 'hermes', messages)
messages.push({ role: 'assistant', content: [{ type: 'text', text: first }] })
messages.push({ role: 'user', content: [{ type: 'text', text: 'Which word did I ask you to remember? Reply with just that word.' }] })
const second = await turn('turn 2', other, messages)

const ok = second.toUpperCase().includes('ORCHID')
console.log(ok ? '\nMODEL SWITCH OK' : '\nMODEL SWITCH FAILED')
adapter.dispose()
process.exitCode = ok ? 0 : 1
