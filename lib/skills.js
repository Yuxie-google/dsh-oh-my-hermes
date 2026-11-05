import { profileName } from './profiles.js'

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// Ask Hermes' own catalog: disabled/platform/project-trust/duplicate rules stay upstream.
// Resolve the Python environment from the configured entry point, including uv shell wrappers.
export function skillsCommand(host, profile) {
  const name = profileName(profile)
  const catalogCode = `import sys,json,contextlib,io,os
sys.path.insert(0,sys.argv[1])
capture=io.StringIO()
with contextlib.redirect_stdout(capture):
 try:
  from pm.environments import activate_dependencies
  from pathlib import Path
  activate_dependencies(Path(sys.argv[1]))
 except ImportError:
  pass
 from hermes_cli.profiles import resolve_profile_env
 os.environ['HERMES_HOME']=resolve_profile_env(sys.argv[2])
 from tools.skills_tool import skills_list
 result=json.loads(skills_list())
print(json.dumps(result,ensure_ascii=False))`
  const script = `# dsh:skills-catalog
import json, os, re, shlex, shutil, subprocess, sys
from pathlib import Path
entry = shutil.which(sys.argv[1]) or sys.argv[1]
p = Path(entry).expanduser().resolve()
roots = []
python = None
for _ in range(4):
    if not p.is_file(): raise SystemExit('Hermes entry point not found')
    text = p.read_text(encoding='utf-8')
    roots.extend([p.parent.parent, p.parent.parent.parent])
    roots.extend(Path(x) for x in re.findall(r"sys.path.insert\\(0, ['\\\"]([^'\\\"]+)['\\\"]\\)", text.replace("'\\\"'\\\"'", "'")))
    first = text.splitlines()[0]
    if first.startswith('#!') and 'python' in first:
        python = shlex.split(first[2:])[0]
        if python.endswith('/env'): python = shutil.which('python3')
        break
    match = re.search(r'^exec ([^\\n]+)', text, re.M)
    if not match: raise SystemExit('Unsupported Hermes launcher; cannot resolve its Python environment')
    tokens = shlex.shlex(match.group(1), posix=True)
    tokens.whitespace_split = True
    p = Path(next(tokens)).expanduser().resolve()
    if 'python' in p.name:
        python = str(p)
        break
repo = next((r for r in roots if (r/'hermes_cli/main.py').is_file()), None)
if not python or not repo: raise SystemExit('Cannot locate Hermes runtime for skill discovery')
code = ${JSON.stringify(catalogCode)}
result = subprocess.run([python, '-c', code, str(repo), sys.argv[2]], capture_output=True, text=True, timeout=15)
if result.returncode: raise SystemExit(result.stderr[-2000:] or 'Hermes skill discovery failed')
print(result.stdout)
`
  return `${host.remoteCwd ? `cd ${quote(host.remoteCwd)} && ` : ''}python3 -c ${quote(script)} ${quote(host.command || 'hermes')} ${quote(name)}`
}

export function parseSkills(text) {
  const data = JSON.parse(text)
  if (data?.success !== true || !Array.isArray(data.skills) || data.skills.length > 2000) throw new Error('远端技能目录无效，请检查 Hermes 版本及技能配置')
  const seen = new Set()
  return data.skills.map((row) => {
    if (typeof row?.name !== 'string' || !row.name.trim() || row.name.length > 256 || /[\x00-\x1f\x7f]/.test(row.name) || seen.has(row.name)) throw new Error('远端技能名称无效或重复')
    seen.add(row.name)
    return { name: row.name, description: typeof row.description === 'string' ? row.description.slice(0, 1200) : '', category: typeof row.category === 'string' ? row.category.slice(0, 120) : '' }
  })
}
