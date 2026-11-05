/** Profile operations use the remote CLI; no credentials or profile contents are returned. */
export function profileName(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string') throw new Error('profile 名称必须是字符串')
  const name = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('profile 名称需为 1–64 位小写字母、数字、连字符或下划线，并以字母或数字开头')
  return name
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// CLI list has no JSON flag. Read names/identity markers only, without reading config or .env.
export const LIST_PROFILES_SCRIPT = `import json, os, re
from pathlib import Path
root = Path(os.environ.get('HERMES_HOME') or '~/.hermes').expanduser()
if not root.is_dir():
    raise SystemExit('Hermes home directory not found')
markers = ('config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db')
names = ['default']
folder = root / 'profiles'
if folder.is_dir():
    for item in sorted(folder.iterdir()):
        if item.is_dir() and not item.is_symlink() and item.name != 'default' and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', item.name) and any((item / marker).is_file() for marker in markers):
            names.append(item.name)
active_file = root / 'active_profile'
active = active_file.read_text(encoding='utf-8-sig').strip() if active_file.is_file() else 'default'
print(json.dumps({'profiles': [{'name': name, 'active': name == active} for name in names]}, ensure_ascii=False))
`

export const listProfilesCommand = () => `python3 -c ${quote(LIST_PROFILES_SCRIPT)}`

export function parseProfiles(text) {
  const data = JSON.parse(text)
  if (!Array.isArray(data?.profiles)) throw new Error('远端 profile 列表格式无效')
  const seen = new Set()
  return data.profiles.map((row) => {
    const name = profileName(row?.name)
    if (seen.has(name)) throw new Error('远端 profile 列表包含重复名称')
    seen.add(name)
    return { name, active: row.active === true }
  })
}

export function validateProfileCreate(draft) {
  const name = profileName(draft?.name)
  if (name === 'default') throw new Error('default 是默认 profile，不能重复创建')
  const description = typeof draft.description === 'string' ? draft.description.trim() : ''
  if (description.length > 500) throw new Error('职责说明最多 500 个字符')
  const cloneFrom = profileName(draft.cloneFrom, { optional: true })
  const instructions = typeof draft.instructions === 'string' ? draft.instructions.trim() : ''
  if (instructions.length > 8000 || /\x00/.test(instructions + description)) throw new Error('长期指令最多 8000 个字符，且不能包含空字符')
  return { name, description, cloneFrom, instructions }
}

export function createProfileCommand(host, draft) {
  const clean = validateProfileCreate(draft)
  const args = [quote(host.command || 'hermes'), 'profile', 'create', quote(clean.name), '--no-alias']
  if (clean.cloneFrom) args.push('--clone-from', quote(clean.cloneFrom))
  if (clean.description) args.push('--description', quote(clean.description))
  const call = `${host.remoteCwd ? `cd ${quote(host.remoteCwd)} && ` : ''}${args.join(' ')}`
  if (!clean.instructions) return call
  // Only runs after create succeeds, so a duplicate-name error cannot overwrite an existing identity.
  const script = `import os, sys\nfrom pathlib import Path\nroot = Path(os.environ.get('HERMES_HOME') or '~/.hermes').expanduser()\np = root / 'profiles' / sys.argv[1]\nif not p.is_dir() or p.is_symlink(): raise SystemExit('Created profile directory not found')\ntmp = p / '.SOUL.dsh-new'\ntmp.write_text(sys.argv[2] + '\\n', encoding='utf-8')\ntmp.replace(p / 'SOUL.md')\n`
  return `${call} && python3 -c ${quote(script)} ${quote(clean.name)} ${quote(clean.instructions)}`
}

export function modelCacheCommand(profile = '') {
  const name = profileName(profile, { optional: true })
  // Empty keeps the legacy root/default cache. Explicit default also uses the root.
  return !name || name === 'default' ? 'cat ~/.hermes/provider_models_cache.json'
    : `cat ~/.hermes/profiles/${quote(name)}/provider_models_cache.json`
}

/** A fresh clone has no model cache. Reuse default's cache only for identical model configuration. */
export function modelCacheFallbackCommand(profile) {
  const name = profileName(profile)
  if (name === 'default') throw new Error('default 无需回退模型缓存')
  const script = `# dsh:model-cache-fallback\nimport json, os, sys, yaml\nfrom pathlib import Path\nroot = Path(os.environ.get('HERMES_HOME') or '~/.hermes').expanduser()\nhome = root / 'profiles' / sys.argv[1]\nif not home.is_dir() or home.is_symlink(): raise SystemExit('Profile does not exist')\ndef model_config(folder):\n    data = yaml.safe_load((folder / 'config.yaml').read_text(encoding='utf-8')) or {}\n    return data.get('model')\nmodel = model_config(home)\nif not model or model != model_config(root): raise SystemExit('Profile has no model cache and its model configuration differs from default')\nprint((root / 'provider_models_cache.json').read_text(encoding='utf-8'))\n`
  return `python3 -c ${quote(script)} ${quote(name)}`
}
