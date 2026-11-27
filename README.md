# AI Proxy

Local gateway that exposes **Anthropic Messages API** (`/v1/messages`, `/v1/models`, `/v1/messages/count_tokens`) and **OpenAI / Codex API** (`/v1/chat/completions`, `/v1/responses`, `/openai/v1/models`) on top of local AI CLIs already installed on your machine.

Includes both a **Node.js CLI proxy** and a **cross-platform Tauri Desktop app (AI Proxy)** for Windows, macOS, and Linux.

## Supported Backends

Any installed CLI is picked up automatically from OpenBot's `provider-runtimes` / `provider-accounts` directories or your system `PATH`:

| Backend | Prefix | Protocol |
| --- | --- | --- |
| Cognition Devin CLI | *(default)* | ACP |
| Google Antigravity (multi-account) | `agy-<id>.` | ACP |
| OpenCode (`go-free`, `all`, or `custom`) | `oc-go.` / `oc-free.` / `oc.` | ACP |
| xAI Grok CLI | `grok.` | ACP |
| OpenAI Codex CLI | `codex.` | `codex app-server` |
| GitHub Copilot CLI | `copilot.` | ACP |
| Cursor CLI | `cursor.` | ACP |
| Cline CLI | `cline.` | ACP |
| Mistral Vibe CLI | `mistral.` | ACP |
| Kimi CLI | `kimi.` | ACP |
| Hermes CLI | `hermes.` | ACP |
| Custom ACP Agents | `acp-<id>.` | ACP |

## Desktop App (AI Proxy)

Download prebuilt installers from the [Releases](https://github.com/Pancakecreates/AI-Proxy/releases) page:
- Windows: `*-setup.exe` / `.msi`
- macOS (Universal): `.dmg`
- Linux: `.AppImage` / `.deb`

Desktop features:
- **Dual HTTP listeners**: Anthropic gateway on `:8787` and OpenAI/Codex gateway on `:8788` (configurable; both protocols also work together on the main port).
- **Accounts & CLI management**: inspect live quotas (Antigravity & Codex), sign in / add accounts in-app, configure Custom ACP agents, and download missing CLI runtimes on demand.
- **Built-in SQLite history**: local test chat with reasoning blocks, full request/error logs, token breakdown, and API-equivalent cost analytics.
- **System integration**: light/dark/auto themes, custom frameless window controls, minimize-to-tray, OS autostart, and in-app GitHub Releases update checker.

## Dual Gateway Usage & Request Formats

You can connect both Anthropic clients and OpenAI / Codex clients at the same time.

### 1. Anthropic Messages API (`http://127.0.0.1:8787`)

Use for **Claude Desktop** (Developer Mode -> Third-Party Inference -> Gateway), **Claude Code**, or Anthropic SDKs:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy"
  }
}
```

Endpoints:
- `GET /v1/models` (auto-generates `claude-fable-acp-...` gateway aliases for Claude Desktop; pass `?raw=1` for raw qualified IDs)
- `POST /v1/messages` (streaming SSE with `thinking` blocks + non-streaming JSON)
- `POST /v1/messages/count_tokens`

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: local-proxy" \
  -d '{
    "model": "codex.gpt-5.4",
    "max_tokens": 1024,
    "output_config": { "effort": "high" },
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

### 2. OpenAI & Codex API (`http://127.0.0.1:8788/v1` or `http://127.0.0.1:8787/openai/v1`)

Port `8788` (or `/openai/v1/*` on port `8787`) speaks standard OpenAI format directly and uses native model IDs such as `codex.gpt-5.4` or `agy-primary.gemini-4-hydrogen`.

**Chat Completions** (`POST /v1/chat/completions`):

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-proxy" \
  -d '{
    "model": "grok.grok-4.7",
    "reasoning_effort": "high",
    "stream": true,
    "messages": [
      { "role": "system", "content": "You are concise." },
      { "role": "user", "content": "Explain epoll vs kqueue." }
    ]
  }'
```

**Responses API / Codex CLI** (`POST /v1/responses`):

```bash
curl http://127.0.0.1:8788/v1/responses \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-proxy" \
  -d '{
    "model": "codex.gpt-5.4",
    "instructions": "You are a coding assistant.",
    "reasoning": { "effort": "medium" },
    "input": "Write a tiny HTTP health check in Rust."
  }'
```

**Codex CLI configuration** (`~/.codex/config.toml`):

```toml
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "AI Proxy"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

## CLI Quick Start

Requirements: Node.js >= 20 and at least one authenticated local AI CLI.

```bash
git clone https://github.com/Pancakecreates/AI-Proxy.git
cd AI-Proxy
npm install
cp .env.example .env
npm run build
npm start
```

### CLI Options & Environment Variables

| Variable / Flag | Default | Description |
| --- | --- | --- |
| `PORT` / `--port` | `8787` | Main HTTP listen port |
| `OPENAI_PORT` / `--openai-port` | unset | Optional second listener dedicated to OpenAI format (e.g. `8788`) |
| `HOST` / `--host` | `127.0.0.1` | Bind address |
| `PROXY_API_KEY` / `--api-key` | unset | Optional `x-api-key` / `Authorization: Bearer ...` secret |
| `DEVIN_CWD` / `--cwd` | User home | Working directory for agent sessions |
| `DEVIN_MODE` / `--mode` | `bypass` | Permission mode: `bypass`, `accept-edits`, `smart`, `ask`, `plan` |
| `DEVIN_MODEL` / `--model` | `swe-2-1-medium` | Fallback model ID |
| `DEVIN_THOUGHT_LEVEL` / `--thought-level` | unset | Default effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `DEVIN_SPEED` / `--speed` | unset | Default speed: `standard`, `fast`, `ultrafast` |
| `ENABLE_ANTHROPIC` / `ENABLE_OPENAI` | `true` | Toggle Anthropic or OpenAI protocol handlers |
| `ENABLE_DEVIN`, `ENABLE_ANTIGRAVITY`, `ENABLE_OPENCODE`, `ENABLE_GROK`, `ENABLE_CODEX` | auto | Enable/disable core backends |
| `ENABLE_COPILOT`, `ENABLE_CURSOR`, `ENABLE_CLINE`, `ENABLE_MISTRAL`, `ENABLE_KIMI`, `ENABLE_HERMES` | auto | Enable/disable additional ACP backends (`--no-copilot`, etc.) |
| `CUSTOM_ACP_AGENTS` / `--custom-acp` | `[]` | JSON array of custom ACP definitions (`{id,name,command,args,env,cwd,authMethodId,enabled}`) |

## Building from Source

```bash
# Node.js CLI
npm run typecheck
npm run build
npm test

# Desktop App (requires Rust >= 1.77 and Node >= 20)
cd desktop
npm install
npm run tauri build
```

## License

[MIT](LICENSE)
