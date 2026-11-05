import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

async function fixture(t, rejection, options = {}) {
  let adapter, handler
  const calls = []
  const children = []
  const ctx = {
    llm: {
      registerAdapter: (_, instance) => { adapter = instance; const handle = () => {}; handle.replace = () => {}; return handle },
      registerConfigurableProviders: () => () => {},
    },
    inject: (_, fn) => fn({ webServer: { register: (spec) => { handler = spec.handler; return () => {} } }, connection: { requestRejection: rejection ?? (() => undefined) } }),
    on: () => {},
  }
  apply(ctx, {
    stateDir: mkdtempSync(join(tmpdir(), 'hermes-routes-')),
    hosts: [{ id: 'box', sshHost: 'saved.test' }], sshArgs: ['-p', '2222'],
    spawnProcess: (_, args) => {
      calls.push(args)
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      children.push(child)
      child.kill = () => child.emit('close', -1)
      setImmediate(() => {
        const command = args.at(-1)
        if (command.includes('dsh:skills-catalog')) {
          if (options.failSkills) { child.stderr.emit('data', 'Skill discovery unavailable'); child.emit('close', 1); return }
          child.stdout.emit('data', options.skillsOutput ?? '{"success":true,"skills":[{"name":"debugging","description":"Find the cause","category":"development"}]}'); child.emit('close', 0); return
        }
        if (options.holdProfiles && command.includes('profile create')) return
        if (options.missingProfileCache && command.startsWith('cat ') && command.includes('/profiles/')) {
          child.stderr.emit('data', 'No such file or directory'); child.emit('close', 1); return
        }
        if (command.includes('dsh:model-cache-fallback')) {
          if (options.differentModelConfig) { child.stderr.emit('data', 'Model configuration differs from default'); child.emit('close', 1); return }
          child.stdout.emit('data', '{"provider#abc":{"models":["shared-a","shared-b"]}}'); child.emit('close', 0); return
        }
        child.stdout.emit('data', command.startsWith('cat ') ? '{"provider#abc":{"models":["a","b"]}}'
          : command.startsWith('python3 -c') ? options.profilesOutput ?? '{"profiles":[{"name":"default","active":true},{"name":"coder"}]}' : 'Hermes 1.0\n')
        if (options.failCreate && command.includes('profile create')) { child.stderr.emit('data', 'Profile already exists'); child.emit('close', 1); return }
        child.emit('close', 0)
      })
      return child
    },
  })
  const server = createServer(handler)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => { adapter.dispose(); await new Promise((done) => server.close(done)) })
  return { adapter, calls, children, request: (path, init) => fetch(`http://127.0.0.1:${server.address().port}/dsh-oh-my-hermes${path}`, init) }
}

test('routes reject unauthorized requests before reading or changing state', async (t) => {
  const { request, calls } = await fixture(t, () => 403)
  for (const path of ['/config', '/sessions', '/models?host=box', '/profiles?host=box', '/skills?host=box&model=hermes']) assert.equal((await request(path)).status, 403)
  assert.equal((await request('/profiles', { method: 'POST', body: JSON.stringify({ name: 'coder', host: { id: 'box' } }) })).status, 403)
  assert.equal(calls.length, 0)
})

test('authentication errors fail closed', async (t) => {
  const { request } = await fixture(t, () => { throw new Error('connection unavailable') })
  assert.equal((await request('/config')).status, 403)
})

test('model discovery probes the edited destination, with configured SSH options', async (t) => {
  const { request, calls } = await fixture(t)
  const response = await request('/models?host=box&sshHost=unsaved.test&sshUser=alice')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).models, ['a', 'b'])
  assert.equal(calls[0].at(-2), 'alice@unsaved.test')
  assert.ok(calls[0].includes('2222'))
  assert.equal((await request('/models?host=box', { method: 'POST' })).status, 405)
})

test('connection test checks the working directory and rejects SSH option injection', async (t) => {
  const { request, calls } = await fixture(t)
  const response = await request('/test', { method: 'POST', body: JSON.stringify({ sshHost: 'draft.test', command: '/opt/hermes', remoteCwd: "/work/it's here" }) })
  assert.equal((await response.json()).ok, true)
  assert.match(calls[0].at(-1), /^cd .* && '\/opt\/hermes' --version$/)
  const invalid = await request('/test', { method: 'POST', body: JSON.stringify({ sshHost: '-oProxyCommand=bad' }) })
  // runRemote returns the invalid-target error as a failed probe, without spawning.
  assert.equal((await invalid.json()).ok, false)
  assert.equal(calls.length, 1)
})

test('configuration route persists canonical host ids and reports pending restart', async (t) => {
  const { request, adapter } = await fixture(t)
  const saved = await request('/config', { method: 'PUT', body: JSON.stringify({ hosts: [{ sshHost: 'new.test' }] }) })
  const data = await saved.json()
  assert.equal(data.restartRequired, true)
  assert.equal(data.saved.hosts[0].id, 'hermes-remote')
  assert.equal((await (await request('/config')).json()).hosts[0].sshHost, 'new.test')
  assert.equal(adapter.byId.has('box'), true)
})

test('session routes list, protect active turns, and reset local mappings', async (t) => {
  const { request, adapter } = await fixture(t)
  const store = adapter.storeFor('box')
  store.set('box:chat', { session: 'remote', model: '', scope: adapter.scopeOf(adapter.hosts[0]) })
  const view = await (await request('/sessions')).json()
  assert.equal(view.sessions[0].remoteSession, 'remote')
  adapter.locks.set('box:chat', Promise.resolve())
  const init = { method: 'DELETE', body: JSON.stringify({ provider: 'box', sessionId: 'chat' }) }
  assert.equal((await request('/sessions', init)).status, 400)
  adapter.locks.clear()
  assert.equal((await request('/sessions', init)).status, 200)
  assert.equal(store.map.size, 0)
})

test('profile listing returns public metadata and uses the edited host and SSH arguments', async (t) => {
  const { request, calls } = await fixture(t)
  const response = await request('/profiles?host=box&sshHost=edited.test&sshUser=alice')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).profiles[1].name, 'coder')
  assert.equal(calls[0].at(-2), 'alice@edited.test')
  assert.ok(calls[0].includes('2222'))
})

test('profile creation validates before executing and invokes the explicit draft host', async (t) => {
  const { request, calls } = await fixture(t)
  const invalid = await request('/profiles', { method: 'POST', body: JSON.stringify({ name: '../bad', host: { id: 'box' } }) })
  assert.equal(invalid.status, 400)
  assert.equal(calls.length, 0)
  const result = await request('/profiles', { method: 'POST', body: JSON.stringify({ name: 'Coder', cloneFrom: 'default', instructions: 'You code carefully.', host: { id: 'box', sshHost: 'new.test', command: '/opt/hermes' } }) })
  assert.equal(result.status, 201)
  const body = await result.json()
  assert.equal(body.profile.name, 'coder')
  assert.equal(body.profile.instructions, undefined)
  assert.equal(calls[0].at(-2), 'new.test')
  assert.match(calls[0].at(-1), /--no-alias --clone-from 'default'/)
})

test('simultaneous same-host profile creation is refused until the first request completes', async (t) => {
  const { request, calls, children, adapter } = await fixture(t, undefined, { holdProfiles: true })
  const init = { method: 'POST', body: JSON.stringify({ name: 'coder', host: { id: 'box' } }) }
  const pending = request('/profiles', init)
  const deadline = Date.now() + 2000
  while (calls.length === 0 && Date.now() < deadline) await new Promise((done) => setImmediate(done))
  assert.equal(calls.length, 1)
  assert.equal((await request('/profiles', init)).status, 409)
  children[0].stdout.emit('data', 'Created coder'); children[0].emit('close', 0)
  assert.equal((await pending).status, 201)
  assert.equal(adapter.profileJobs.size, 0)
})

test('failed profile creation releases the reservation for a retry', async (t) => {
  const { request, adapter } = await fixture(t, undefined, { failCreate: true })
  const response = await request('/profiles', { method: 'POST', body: JSON.stringify({ name: 'coder', host: { id: 'box' } }) })
  assert.equal(response.status, 502)
  assert.match((await response.json()).error, /already exists/)
  assert.equal(adapter.profileJobs.size, 0)
})

test('profile cache discovery stays within the selected identity and rejects traversal', async (t) => {
  const { request, calls } = await fixture(t)
  assert.equal((await request('/models?host=box&profile=coder')).status, 200)
  assert.match(calls[0].at(-1), /profiles\/'coder'\/provider_models_cache/)
  assert.equal((await request('/models?host=box&profile=..%2Fother')).status, 400)
  assert.equal(calls.length, 1)
})

test('malformed remote profile metadata is a gateway error', async (t) => {
  const { request } = await fixture(t, undefined, { profilesOutput: 'unexpected chatter' })
  assert.equal((await request('/profiles?host=box')).status, 502)
})

test('a new clone can discover default candidates and reports their source', async (t) => {
  const { request, calls } = await fixture(t, undefined, { missingProfileCache: true })
  const response = await request('/models?host=box&profile=coder')
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.deepEqual(data.models, ['shared-a', 'shared-b'])
  assert.equal(data.sourceProfile, 'default')
  assert.equal(calls.length, 2)
})

test('a profile with different model configuration cannot silently inherit default candidates', async (t) => {
  const { request } = await fixture(t, undefined, { missingProfileCache: true, differentModelConfig: true })
  assert.equal((await request('/models?host=box&profile=coder')).status, 502)
})


test('skills resolve the saved selected model identity and reject unknown routes before SSH', async (t) => {
  const { request, adapter, calls } = await fixture(t)
  adapter.applyDraft({ hosts: [{ id: 'box', sshHost: 'saved.test', remoteCwd: '/srv/work', command: '/opt/hermes', models: [{ id: 'coder-row', hermesProfile: 'coder' }, { id: 'default-row' }] }] })
  const response = await request('/skills?host=box&model=coder-row&profile=default')
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.profile, 'coder')
  assert.equal(data.skills[0].name, 'debugging')
  assert.ok(calls[0].at(-1).endsWith("'/opt/hermes' 'coder'"))
  assert.match(calls[0].at(-1), /^cd '\/srv\/work' && /)
  assert.equal((await request('/skills?host=box&model=default-row')).status, 200)
  assert.ok(calls[1].at(-1).endsWith("'/opt/hermes' 'default'"))
  for (const path of ['/skills?host=unknown&model=coder-row', '/skills?host=box&model=removed', '/skills?host=box']) assert.equal((await request(path)).status, 400)
  assert.equal((await request('/skills?host=box&model=coder-row', { method: 'POST' })).status, 405)
  assert.equal(calls.length, 2)
})

test('skill discovery failures and malformed metadata are retryable gateway errors', async (t) => {
  const failed = await fixture(t, undefined, { failSkills: true })
  assert.equal((await failed.request('/skills?host=box&model=hermes')).status, 502)
  const malformed = await fixture(t, undefined, { skillsOutput: '{"success":false,"skills":[]}' })
  assert.equal((await malformed.request('/skills?host=box&model=hermes')).status, 502)
})
