import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skillsCommand, parseSkills } from '../lib/skills.js'

test('skill discovery uses native profile resolution and native filtered catalog in the configured working directory', () => {
  const command = skillsCommand({ command: '/opt/my hermes/bin/hermes', remoteCwd: "/work/it's" }, 'coder')
  assert.match(command, /^cd '/)
  assert.match(command, /resolve_profile_env/)
  assert.match(command, /skills_list\(\)/)
  assert.match(command, /activate_dependencies/)
  assert.ok(command.endsWith("'/opt/my hermes/bin/hermes' 'coder'"))
  assert.doesNotMatch(command, /skill_view\(|chat --|pip install|write_text/)
  for (const value of ['../default', '-p x', 'x;touch y', '']) assert.throws(() => skillsCommand({}, value))
})

test('skill metadata is bounded and excludes skill bodies, paths and arbitrary remote fields', () => {
  assert.deepEqual(parseSkills(JSON.stringify({ success: true, skills: [{ name: 'research/paper', description: 'Find papers', category: 'research', content: 'private body', path: '/private' }] })), [{ name: 'research/paper', description: 'Find papers', category: 'research' }])
  assert.deepEqual(parseSkills('{"success":true,"skills":[]}'), [])
  assert.equal(parseSkills(JSON.stringify({ success: true, skills: [{ name: 'a', description: 'a'.repeat(4000) }] }))[0].description.length, 1200)
  for (const value of [{ success: false, skills: [] }, { success: true, skills: [{ name: 'bad\nname' }] }, { success: true, skills: [{ name: 'a' }, { name: 'a' }] }]) assert.throws(() => parseSkills(JSON.stringify(value)))
  assert.throws(() => parseSkills('not json'))
})
