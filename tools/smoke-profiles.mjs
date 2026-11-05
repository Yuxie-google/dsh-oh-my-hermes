/** Real SSH check: create one temporary identity, chat twice, and delete only that identity. */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesAdapter, runRemote } from '../lib/index.js'
import { createProfileCommand, listProfilesCommand, parseProfiles } from '../lib/profiles.js'

if (!process.env.HERMES_SSH_HOST) throw new Error('Set HERMES_SSH_HOST to your test SSH host.')
const base = new HermesAdapter({}, { stateDir: mkdtempSync(join(tmpdir(), 'hermes-profile-probe-')), hosts: [{ id: 'hermes-remote', sshHost: process.env.HERMES_SSH_HOST, sshUser: process.env.HERMES_SSH_USER || '', command: process.env.HERMES_COMMAND || 'hermes', remoteCwd: process.env.HERMES_REMOTE_CWD || '' }] })
const host = base.hosts[0]
const name = `dsh-test-${Date.now().toString(36)}`
const instructions = 'You are an isolated coding test assistant. Remember requested test words and reply briefly.'
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
let created = false, adapter
try {
  const before = await runRemote(base, host, listProfilesCommand())
  assert.equal(before.code, 0, before.error)
  const initial = parseProfiles(before.stdout)
  assert.equal(initial.some((p) => p.name === name), false)
  const result = await runRemote(base, host, createProfileCommand(host, { name, cloneFrom: 'default', description: 'Temporary DSH plugin integration test', instructions }), 60000)
  assert.equal(result.code, 0, result.error)
  created = true
  console.log(`Created temporary profile ${name}.`)
  const soul = await runRemote(base, host, `cat ~/.hermes/profiles/${quote(name)}/SOUL.md`)
  assert.equal(soul.stdout.trim(), instructions)
  const listed = await runRemote(base, host, listProfilesCommand())
  const names = parseProfiles(listed.stdout)
  assert.ok(names.some((p) => p.name === name))
  assert.deepEqual(names.filter((p) => p.active), initial.filter((p) => p.active), 'Sticky default is unchanged')
  adapter = new HermesAdapter({}, {
    ...base.config, hosts: [{ ...host, models: [{ id: 'test', name: 'Test profile', hermesProfile: name }] }],
    stateDir: mkdtempSync(join(tmpdir(), 'hermes-profile-smoke-')), turnTimeoutMs: 120000,
  })
  const messages = [{ role: 'user', content: 'Remember the word CEDAR. Reply exactly: R1' }]
  const turn = async () => {
    let text = '', finish
    for await (const chunk of adapter.stream(host.id, { sessionId: 'profile-smoke', model: 'test', messages })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    assert.equal(finish.kind, 'stop', JSON.stringify(finish))
    return text
  }
  const first = await turn()
  messages.push({ role: 'assistant', content: first }, { role: 'user', content: 'What word did I ask you to remember? Reply with just the word.' })
  const second = await turn()
  assert.match(second, /CEDAR/i)
  assert.equal(adapter.sessionsView()[0].profile, name)
  console.log('Profile-specific instructions, explicit profile routing, and two-turn resume passed.')
} finally {
  adapter?.dispose()
  if (created && /^dsh-test-[a-z0-9]+$/.test(name)) {
    const deleted = await runRemote(base, host, `${quote(host.command)} profile delete ${quote(name)} --yes`, 60000)
    if (deleted.code !== 0) { console.error(`Temporary profile cleanup failed for ${name}: ${base.redact(deleted.error)}`); process.exitCode = 1 }
    else console.log(`Deleted temporary test profile ${name}.`)
  }
  base.dispose()
}
