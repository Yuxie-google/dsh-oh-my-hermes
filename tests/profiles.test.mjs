import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesAdapter, validateDraft, configView, SessionStore } from '../lib/index.js'
import { profileName, parseProfiles, validateProfileCreate, createProfileCommand, modelCacheCommand, modelCacheFallbackCommand } from '../lib/profiles.js'
import { registerCommandDefinitions } from '../lib/commands.js'

const tick = () => new Promise((done) => setImmediate(done))
const drain = async (stream) => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
const opts = (model, sessionId = 'chat') => ({ model, sessionId, messages: [{ role: 'user', content: 'hello' }] })
function fixture(t) {
  const calls = []
  const adapter = new HermesAdapter({}, {
    stateDir: mkdtempSync(join(tmpdir(), 'hermes-profile-')), persistSessions: true,
    hosts: [{ id: 'box', sshHost: 'example.test', models: [{ id: 'coder', hermesProfile: 'coder' }, { id: 'researcher', hermesProfile: 'researcher' }, { id: 'base' }] }],
    spawnProcess: (_, args) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
      child.stdin.end = (text) => { child.prompt = text }
      child.kill = () => child.emit('close', -1)
      child.complete = (session) => {
        child.stdout.emit('data', `${JSON.stringify({ type: 'result', session_id: session, exit_code: 0, text: 'OK' })}\n`)
        child.emit('close', 0)
      }
      calls.push({ args, child })
      return child
    },
  })
  t.after(() => adapter.dispose())
  return { adapter, calls }
}

test('profile names are canonical and cannot escape their directory or become options', () => {
  assert.equal(profileName(' Coder-1 '), 'coder-1')
  assert.equal(profileName(undefined, { optional: true }), '')
  for (const value of [3, null, '', '../other', '-p', 'a/b', 'a\\b', 'a b', 'x\n../y', 'a'.repeat(65)]) assert.throws(() => profileName(value))
})

test('creating a profile validates role, clone source and instructions before remote execution', () => {
  const clean = validateProfileCreate({ name: ' Coder ', cloneFrom: 'Default', description: ' code ', instructions: ' be careful ' })
  assert.deepEqual(clean, { name: 'coder', cloneFrom: 'default', description: 'code', instructions: 'be careful' })
  assert.throws(() => validateProfileCreate({ name: 'default' }), /不能重复/)
  assert.throws(() => validateProfileCreate({ name: 'coder', description: 'x'.repeat(501) }), /500/)
  assert.throws(() => validateProfileCreate({ name: 'coder', instructions: 'x\0y' }), /空字符/)
  assert.throws(() => validateProfileCreate({ name: 'coder', cloneFrom: '../default' }))
})

test('create command never changes sticky defaults, clones channels, or installs aliases', () => {
  const command = createProfileCommand({ command: '/opt/hermes', remoteCwd: '/work dir' }, { name: 'coder', cloneFrom: 'default', description: "code's role" })
  assert.match(command, /^cd '\/work dir' && /)
  assert.match(command, /profile create 'coder' --no-alias --clone-from 'default'/)
  assert.doesNotMatch(command, /profile use|clone-all|clone-channels/)
  assert.match(command, /code'\\''s role/)
})

test('long-term instructions are applied only after successful creation, with shell quoting', () => {
  const command = createProfileCommand({ command: '/opt/hermes' }, { name: 'coder', instructions: "don't run $(touch /tmp/bad)\nStay careful." })
  assert.match(command, /--no-alias && python3 -c/)
  assert.match(command, /SOUL\.md/)
  assert.match(command, /don'\\''t run/)
  assert.match(command, /\$\(touch \/tmp\/bad\)/)
})

test('profile list parsing exposes names and active flags, never config or credentials', () => {
  assert.deepEqual(parseProfiles('{"profiles":[{"name":"default","active":true,"api_key":"hidden"},{"name":"coder"}]}'), [{ name: 'default', active: true }, { name: 'coder', active: false }])
  assert.throws(() => parseProfiles('{"profiles":[{"name":"../x"}]}'))
  assert.throws(() => parseProfiles('{"profiles":[{"name":"x"},{"name":"x"}]}'), /重复/)
  assert.throws(() => parseProfiles('{}'), /无效/)
})

test('model discovery uses the chosen profile cache', () => {
  assert.equal(modelCacheCommand(), 'cat ~/.hermes/provider_models_cache.json')
  assert.equal(modelCacheCommand('default'), modelCacheCommand())
  assert.equal(modelCacheCommand('coder'), "cat ~/.hermes/profiles/'coder'/provider_models_cache.json")
  assert.throws(() => modelCacheCommand('../other'))
})

test('a clone can use default model candidates only after its model configuration matches', () => {
  const command = modelCacheFallbackCommand('coder')
  assert.match(command, /model != model_config\(root\)/)
  assert.match(command, /config\.yaml/)
  assert.match(command, /provider_models_cache\.json/)
  assert.throws(() => modelCacheFallbackCommand('../other'))
  assert.throws(() => modelCacheFallbackCommand('default'))
})

test('model-row profiles round-trip through validation and the settings view', (t) => {
  const { adapter } = fixture(t)
  const draft = validateDraft({ hosts: [{ id: 'box', sshHost: 'x', models: [{ id: 'coding', hermesProfile: 'Coder' }] }] })
  assert.equal(draft.hosts[0].models[0].hermesProfile, 'coder')
  adapter.applyDraft(draft)
  assert.equal(configView(adapter).hosts[0].models[0].hermesProfile, 'coder')
  assert.throws(() => validateDraft({ hosts: [{ sshHost: 'x', models: [{ id: 'bad', hermesProfile: '../bad' }] }] }))
})

test('named profiles are passed before chat, and profile switches never resume the preceding identity', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', opts('coder')))
  await tick(); assert.match(calls[0].args.at(-1), /-p 'coder' chat/)
  calls[0].child.complete('coder-session'); await first
  const second = drain(adapter.stream('box', opts('coder')))
  await tick(); assert.match(calls[1].args.at(-1), /--resume 'coder-session'/)
  calls[1].child.complete('coder-session'); await second
  const third = drain(adapter.stream('box', opts('researcher')))
  await tick(); assert.match(calls[2].args.at(-1), /-p 'researcher' chat/)
  assert.doesNotMatch(calls[2].args.at(-1), /--resume/)
  calls[2].child.complete('research-session'); await third
  assert.equal(adapter.sessionsView()[0].profile, 'researcher')
  assert.equal(adapter.sessionsView()[0].compatible, true)
})

test('profile selection survives state reload with its identity binding', async (t) => {
  const { adapter, calls } = fixture(t)
  const task = drain(adapter.stream('box', opts('coder')))
  await tick(); calls[0].child.complete('coder-remote'); await task
  const store = adapter.storeFor('box'); store.flush()
  const reloaded = new SessionStore(store.file)
  assert.equal(reloaded.get('box:chat').profile, 'coder')
  assert.equal(reloaded.get('box:chat').scope, adapter.scopeOf({ ...adapter.hosts[0], hermesProfile: 'coder' }))
})

test('two DSH sessions writing one named profile run in order', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', opts('coder', 'one')))
  await tick()
  const second = drain(adapter.stream('box', opts('coder', 'two')))
  await tick(); assert.equal(calls.length, 1)
  calls[0].child.complete('one'); await first; await tick()
  assert.equal(calls.length, 2)
  assert.doesNotMatch(calls[1].args.at(-1), /--resume/)
  calls[1].child.complete('two'); await second
  assert.equal(adapter.homeLocks.size, 0)
})

test('different named profiles may work independently', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', opts('coder', 'one')))
  const second = drain(adapter.stream('box', opts('researcher', 'two')))
  await tick(); assert.equal(calls.length, 2)
  calls[0].child.complete('one'); calls[1].child.complete('two')
  await Promise.all([first, second])
})

test('cancelling while waiting for the identity lock spawns no extra child', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', opts('coder', 'one')))
  await tick()
  const controller = new AbortController()
  const second = drain(adapter.stream('box', { ...opts('coder', 'two'), signal: controller.signal }))
  await tick(); controller.abort()
  assert.equal((await second).at(-1).reason.kind, 'aborted')
  assert.equal(calls.length, 1)
  calls[0].child.complete('one'); await first; await tick()
  assert.equal(adapter.homeLocks.size, 0)
})

test('/hermes-profiles lists connected identities and points to profile creation', (t) => {
  const { adapter } = fixture(t)
  const definitions = new Map()
  const dispose = registerCommandDefinitions({ register: (d) => { definitions.set(d.name, d); return () => {} } }, adapter)
  t.after(dispose)
  const result = definitions.get('hermes-profiles').handler({ rawInput: 'box' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /coder/)
  assert.match(result.text, /researcher/)
  assert.match(result.text, /设置 → 远程 Hermes/)
})

test('a stale profile/model selection cannot silently fall back to the default identity', async (t) => {
  const { adapter, calls } = fixture(t)
  await assert.rejects(adapter.resolveModel('box', 'removed-profile'), /重新选择/)
  const chunks = await drain(adapter.stream('box', opts('removed-profile')))
  assert.equal(chunks.at(-1).reason.failure.code, 'MODEL_NOT_CONFIGURED')
  assert.equal(calls.length, 0)
  assert.equal(adapter.locks.size, 0)
})

test('model picker and resolved selection both name the identity without changing model ids', async (t) => {
  const { adapter } = fixture(t)
  adapter.applyDraft({ hosts: [{ id: 'box', sshHost: 'example.test', models: [
    { id: 'deepseek', name: 'deepseek', hermesModel: 'deepseek', hermesProfile: 'coder' },
    { id: 'profile-coder', name: 'coder · 默认模型', hermesProfile: 'coder' },
    { id: 'base', name: '原有默认模型' },
  ] }] })
  const models = await adapter.listModels('box')
  assert.deepEqual(models.map((m) => [m.id, m.name]), [
    ['deepseek', 'coder · deepseek'], ['profile-coder', 'coder · 默认模型'], ['base', '原有默认模型'],
  ])
  assert.equal((await adapter.resolveModel('box', 'deepseek')).name, 'coder · deepseek')
  assert.equal((await adapter.resolveModel('box', 'profile-coder')).name, 'coder · 默认模型')
})
