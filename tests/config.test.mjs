import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HermesAdapter,
  apply,
  configFileOf,
  configView,
  mergeConfig,
  modelRowFor,
  parseRemoteModels,
  readConfigFile,
  validateDraft,
  writeConfigFile,
} from '../lib/index.js'

const temp = () => mkdtempSync(join(tmpdir(), 'oh-my-hermes-config-'))

const makeAdapter = (config) => {
  const ctx = { llm: { registerAdapter: () => {}, registerConfigurableProviders: () => () => {} }, logger: () => undefined }
  return new HermesAdapter(ctx, config)
}

test('the settings draft keeps models per host and normalises them', () => {
  const draft = validateDraft({
    hosts: [
      {
        id: ' hermes-remote ',
        name: ' 远程 Hermes ',
        sshHost: ' 203.0.113.10 ',
        sshUser: 'ubuntu',
        command: ' /home/ubuntu/.local/bin/hermes ',
        remoteCwd: '/home/ubuntu',
        models: [
          { id: 'hermes', name: '远端默认模型' },
          { id: 'glm-5.3', hermesModel: 'glm-5.3', contextWindow: '300000', maxTokens: '16000' },
        ],
      },
    ],
  })
  assert.deepEqual(draft.hosts[0], {
    id: 'hermes-remote',
    name: '远程 Hermes',
    sshHost: '203.0.113.10',
    sshUser: 'ubuntu',
    command: '/home/ubuntu/.local/bin/hermes',
    remoteCwd: '/home/ubuntu',
    models: [
      { id: 'hermes', name: '远端默认模型', hermesModel: '', contextWindow: 200000, maxTokens: 32000 },
      { id: 'glm-5.3', name: 'glm-5.3', hermesModel: 'glm-5.3', contextWindow: 300000, maxTokens: 16000 },
    ],
  })
})

test('a host without rows falls back to the shared list, and empty ids are refused', () => {
  const shared = validateDraft({
    hosts: [{ id: 'a', sshHost: 'x' }],
    models: [{ id: 'shared' }],
  })
  assert.equal(shared.hosts[0].models[0].id, 'shared')

  assert.throws(() => validateDraft({ hosts: [{ sshHost: 'x', models: [{ name: 'no id' }] }] }), /needs an id/)
  assert.throws(
    () => validateDraft({ hosts: [{ sshHost: 'x', models: [{ id: 'a' }, { id: 'a' }] }] }),
    /duplicate model id/,
  )
  assert.throws(() => validateDraft({ hosts: [] }), /at least one host/)
  assert.throws(() => validateDraft(null), /config must be an object/)
})

test('the remote model cache is flattened into a sorted list', () => {
  const parsed = parseRemoteModels(JSON.stringify({
    'custom:https://api.modelverse.cn/v1#abc': { models: ['glm-5.3', 'deepseek-v4.1-flash-1017'] },
    'other#def': { models: ['glm-5.3', 'kimi-k2'] },
  }))
  assert.equal(parsed.provider, 'custom:https://api.modelverse.cn/v1')
  assert.deepEqual(parsed.models, ['deepseek-v4.1-flash-1017', 'glm-5.3', 'kimi-k2'])

  const row = modelRowFor('glm-5.3')
  assert.equal(row.id, 'glm-5.3')
  assert.equal(row.hermesModel, 'glm-5.3')
})

test('the config file round-trips and wins over the bundle patch', () => {
  const dir = temp()
  const file = configFileOf(dir)
  assert.equal(readConfigFile(file), undefined)

  const saved = validateDraft({
    hosts: [{
      id: 'box',
      sshHost: '10.0.0.9',
      sshUser: 'ubuntu',
      command: '/opt/hermes',
      remoteCwd: '/srv',
      models: [{ id: 'hermes', name: 'Remote default' }],
    }],
  })
  writeConfigFile(file, saved)
  assert.deepEqual(readConfigFile(file), saved)

  const merged = mergeConfig(
    { hosts: [{ sshHost: 'patch.test' }], models: [{ id: 'from-patch' }], keep: true },
    readConfigFile(file),
  )
  assert.equal(merged.hosts[0].sshHost, '10.0.0.9')
  assert.equal(merged.keep, true)
})

test('an empty file section falls back to the patch', () => {
  const base = { hosts: [{ sshHost: 'patch.test' }], models: [{ id: 'patch' }] }
  const merged = mergeConfig(base, { hosts: [], models: [] })
  assert.equal(merged.hosts[0].sshHost, 'patch.test')
  assert.equal(merged.models[0].id, 'patch')
})

test('the adapter boots from the saved file and reports rows back to the page', () => {
  const dir = temp()
  const file = configFileOf(dir)
  writeConfigFile(file, {
    hosts: [{
      id: 'saved',
      name: 'Saved box',
      sshHost: '10.0.0.9',
      sshUser: 'ubuntu',
      command: '/opt/hermes',
      remoteCwd: '/srv',
      models: [{ id: 'glm-5.3', name: 'GLM 5.3', hermesModel: 'glm-5.3', contextWindow: 279000 }],
    }],
  })
  const adapter = makeAdapter({ sshHost: 'patch.test', providerId: 'patch-provider', stateDir: dir })
  assert.deepEqual(adapter.hosts.map((host) => host.id), ['saved'])
  assert.equal(adapter.hosts[0].name, 'Saved box')
  assert.equal(adapter.hosts[0].models[0].hermesModel, 'glm-5.3')

  const view = configView(adapter)
  assert.equal(view.file, file)
  assert.equal(view.exists, true)
  assert.equal(view.hosts[0].sshHost, '10.0.0.9')
  assert.equal(view.hosts[0].models[0].contextWindow, 279000)
})

test('adding model rows applies live, adding a host asks for a restart', () => {
  const dir = temp()
  const adapter = makeAdapter({
    stateDir: dir,
    hosts: [{ id: 'box', sshHost: '10.0.0.9', models: [{ id: 'hermes' }] }],
  })

  const live = adapter.applyDraft(validateDraft({
    hosts: [{
      id: 'box',
      sshHost: '10.0.0.9',
      models: [{ id: 'hermes' }, { id: 'glm-5.3', hermesModel: 'glm-5.3' }],
    }],
  }))
  assert.equal(live.live, true)
  assert.deepEqual(live.changed, ['box'])
  assert.deepEqual(adapter.hosts[0].models.map((model) => model.id), ['hermes', 'glm-5.3'])

  const restart = adapter.applyDraft(validateDraft({
    hosts: [
      { id: 'box', sshHost: '10.0.0.9', models: [{ id: 'hermes' }] },
      { id: 'second', sshHost: '10.0.0.10', models: [{ id: 'hermes' }] },
    ],
  }))
  assert.equal(restart.live, false)
  assert.deepEqual(adapter.hosts.map((host) => host.id), ['box'])
})

test('a model row decides the -m the remote turn runs', () => {
  const adapter = makeAdapter({
    stateDir: temp(),
    hosts: [{
      id: 'box',
      sshHost: '10.0.0.9',
      command: '/opt/hermes',
      remoteCwd: '/srv',
      models: [{ id: 'hermes' }, { id: 'glm-5.3', hermesModel: 'glm-5.3' }],
    }],
  })
  const host = adapter.hosts[0]
  const base = adapter.buildRemoteCommand(host, { model: 'hermes' }, undefined)
  const pinned = adapter.buildRemoteCommand(host, { model: 'glm-5.3' }, undefined)
  assert.doesNotMatch(base, /-m /)
  assert.match(pinned, /-m 'glm-5\.3'/)
  assert.match(pinned, /--format stream-json/)
})

test('a live save republishes llm/adapters-updated so the picker rebuilds', () => {
  const adapter = makeAdapter({
    stateDir: temp(),
    hosts: [{ id: 'box', sshHost: '10.0.0.9', models: [{ id: 'hermes' }] }],
  })
  let announced = 0
  adapter.announce = () => {
    announced += 1
  }
  const applied = adapter.applyDraft(validateDraft({
    hosts: [{
      id: 'box',
      sshHost: '10.0.0.9',
      models: [{ id: 'hermes' }, { id: 'glm-5.3', hermesModel: 'glm-5.3' }],
    }],
  }))
  assert.equal(applied.live, true)
  assert.equal(announced, 1)
})

test('apply wires that republish into the llm registration handle', () => {
  let adapter
  const replaced = []
  const ctx = {
    llm: {
      registerAdapter: (providers, instance) => {
        adapter = instance
        const handle = () => {}
        handle.replace = (next) => replaced.push(next)
        return handle
      },
      registerConfigurableProviders: () => () => {},
    },
    on: () => {},
  }
  apply(ctx, {
    stateDir: temp(),
    hosts: [{ id: 'box', sshHost: '10.0.0.9', models: [{ id: 'hermes' }] }],
  })
  adapter.applyDraft(validateDraft({
    hosts: [{
      id: 'box',
      sshHost: '10.0.0.9',
      models: [{ id: 'hermes' }, { id: 'glm-5.3', hermesModel: 'glm-5.3' }],
    }],
  }))
  assert.deepEqual(replaced, [['box']])
})
