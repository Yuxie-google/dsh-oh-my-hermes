<div align="center">

<h1><img src="icon.svg" width="40" height="40" alt="Hermes" /> Oh My Hermes</h1>

<p><a href="README.md">中文</a> | <strong>English</strong></p>

<p><strong>Hermes Agent, integrated into DeepSeek Harness</strong></p>

<p><em>Connect to remote Hermes over SSH and use its models, profiles, skills and tools from your DSH conversation.</em></p>

<p>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.10.1-6366f1" alt="Version 1.10.1" /></a>
  <img src="https://img.shields.io/badge/host-dsh-5368d5" alt="Host: DeepSeek Harness" />
  <img src="https://img.shields.io/badge/agent-Hermes-374151" alt="Agent: Hermes" />
  <img src="https://img.shields.io/badge/transport-SSH-0f766e" alt="Transport: SSH" />
  <img src="https://img.shields.io/badge/language-JavaScript-323330?logo=javascript&amp;logoColor=F7DF1E" alt="Language: JavaScript" />
  <img src="https://img.shields.io/badge/runtime_deps-zero-16835d" alt="Runtime dependencies: zero" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb" alt="License: MIT" /></a>
</p>

<p>Issues and pull requests are welcome. See <a href="CONTRIBUTING.md">CONTRIBUTING.md</a> for development and validation.</p>

</div>

---

## Overview

Oh My Hermes (`dsh-oh-my-hermes`) is a model provider plugin for DeepSeek Harness (DSH). It sends conversation requests to a remote Hermes Agent over SSH and streams responses back to DSH.

Model calls, tools, skills and memory remain on the remote machine. The plugin handles transport, presentation and session continuity.

- **Multiple hosts and models** — manage SSH targets, discover remote model candidates and choose model rows in the conversation interface.
- **Native Hermes profiles** — create, clone and bind profiles, with profile-aware session routing.
- **Skill browser** — search the selected profile's available skills and insert a skill request into your draft.
- **Foldable tool activity** — inspect commands, output, completion status and elapsed time without flooding the response.
- **Persistent sessions** — resume completed remote sessions after restarting DSH, with cancellation and timeout handling.

The server uses Node.js built-in modules. The frontend reuses DSH's React runtime and extension slots; no build step is required.

## Requirements

- Node.js **22.15 or later**.
- DSH **>= 0.2.0-rc.1 and < 0.3.0**.
- An SSH-accessible machine with Hermes Agent installed and configured.
- Remote Python 3 for profile and skill discovery. Skill discovery has been verified with **Hermes Agent v0.22.6** and requires compatible native Python APIs.

## Installation

```sh
git clone https://github.com/Yuxie-google/dsh-oh-my-hermes.git
cd dsh-oh-my-hermes
npm pack
dsh plugin --profile desktop add ./dsh-oh-my-hermes-1.10.1.tgz
```

Restart DSH, open **Settings → 远程 Hermes**, and add your SSH host. The plugin does not ship with a real server address. Test the connection, add model rows and save the configuration.

Changes to model rows on existing hosts apply immediately after saving. Adding or removing hosts requires a DSH restart.

To uninstall:

```sh
dsh plugin --profile desktop remove dsh-oh-my-hermes
```

## Profiles and skills

In the settings page, load the remote profiles and add an existing profile as a model row, or create a new profile. Creation supports a blank profile or cloning an existing one. Optional instructions are written to the new profile's `SOUL.md` after creation succeeds.

Cloning can inherit credentials, skills, identity data and curated memories from its source. Creating a profile does not change the remote global default. Discarding an unsaved local model row does not delete a profile already created remotely. A blank profile needs its own remote setup.

Each model row selects a profile and either its default model or a per-turn model override. Use separate DSH conversations when you want independent conversations for different profiles. Switching profiles in the same conversation sends its existing text history to a new remote session.

Select a Hermes model to show the **技能** button beside the workspace controls. Its popover lists skills available to the selected profile. Clicking a skill adds a request to your existing draft; it does not send a message or execute a skill automatically.

## Conversation commands

| Command | Purpose |
|---|---|
| `/hermes` | Show command help |
| `/hermes-status [host]` | Inspect the conversation's remote session and running state |
| `/hermes-models [host]` | List configured model rows |
| `/hermes-profiles [host]` | List connected profiles and show the creation entry point |
| `/hermes-skills [host] [profile]` | Read available skill metadata from the remote profile over SSH |
| `/hermes-hosts` | List configured hosts |
| `/hermes-reset [host]` | Clear this conversation's local resume mapping |

These commands do not call a model. Skill discovery uses SSH; the other commands operate locally. When a skill command cannot determine the intended profile, specify it explicitly, for example `/hermes-skills hermes-remote coder`. The skill popover follows the current model selection directly.

Resetting a mapping preserves DSH history and the original remote session. Active or queued conversations must stop before their mappings can be reset.

## Tool presentation and session continuity

Selecting a Hermes model enables a scoped reading layout for assistant Markdown: a sans-serif font and consistent spacing for paragraphs, headings, lists, tables, quotes and code. Content follows DSH's native chat column and user width preference as the window, sidebar or embedded pane changes; the plugin adds no fixed character-width cap. Native wide-table layout is preserved, and long code and narrow-pane tables scroll within their own regions. Command feedback uses the host's composer width tokens for alignment. The layout respects the host's content font size and code highlighting. User messages and conversations with another provider selected retain the host's styles.

This is a presentation change only: original text, copied content and stored history remain intact. Existing Hermes conversations can use the layout; plain paragraphs are not rewritten into tables.

Remote tool calls and results become read-only Markdown blocks. Details are collapsed by default and can be opened with a click, Enter or Space. Commands and output retain line breaks and indentation; long bodies are truncated with a notice.

Remote tools never become DSH `tool-call` blocks, so DSH does not execute them again. The final answer's Markdown is preserved as received. Existing reasoning-based history is not rewritten; new tool blocks retain their folding markers when stored and reopened. If the frontend cannot recognize the host's Markdown structure, the summary and code block remain readable.

Resume mappings are bound to the SSH target, command, working directory, profile and launch arguments. Changing the model or profile starts a new remote session with the conversation's text history. Failed, interrupted or incomplete turns do not commit a new resume mapping.

Settings are stored in `~/.dsh/oh-my-hermes/config.json`; per-provider resume mappings use the same directory. Local settings take precedence over the bundle patch. See [the Chinese configuration reference](README.md#配置说明) for all available settings and HTTP routes.

## Development

```sh
npm run check
npm test
npm pack
```

The unit tests use temporary directories and mocked SSH processes. Optional browser checks and live SSH smoke tests are documented in [CONTRIBUTING.md](CONTRIBUTING.md) and [README.md](README.md#开发与测试). Live tests require an explicit test host and can consume remote model credits.

## Limitations

- Conversation transport is text-only; image and file attachments are not forwarded.
- Tools execute remotely. DSH displays their activity but does not provide local approval for remote operations.
- Each turn starts an SSH connection and a Hermes process.
- Profiles and skill discovery depend on compatible remote Hermes APIs and an identifiable Python launcher.
- Known credential patterns are redacted from tool activity and diagnostics. Arbitrary secrets that do not match those patterns may still appear in remote output.

## License and references

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) for attribution. Changes and upgrade notes are recorded in [CHANGELOG.md](CHANGELOG.md).
