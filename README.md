# AI-Anthropic-Proxy

Local Anthropic Messages API (`GET /v1/models`, `POST /v1/messages`, `POST /v1/messages/count_tokens`) proxy backed by Cognition Devin CLI over ACP (`devin acp`). Built with zero-dependency **Node.js** ESM so you can connect Claude Desktop (Third-Party Inference) or Claude Code directly to your local Devin agent and any model in your Devin account (Claude, DeepSeek, GPT, Gemini, SWE, Grok, Kimi, GLM).

## Features

- **Anthropic Messages API compatible** — implements `POST /v1/messages` (streaming SSE with `ping` keepalive + `thinking` blocks, and non-streaming JSON), `GET /v1/models`, and `POST /v1/messages/count_tokens`.
- **Any model via Devin ACP** — automatically discovers your full Devin model catalog (`121+` models) and resolves exact IDs, `[1m]` suffixes, Anthropic aliases (`claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`), fuzzy names (`deepseek`, `gemini`, `swe`), or custom `DEVIN_MODEL_MAP` overrides.
- **Stateful session continuation** — matches incoming stateless `messages[]` prefixes onto open Devin ACP sessions and switches models/thinking levels dynamically via `session/set_config_option`.
- **Hands-free local execution** — automatically handles `session/request_permission`, `session/create_elicitation`, `session/cancel` on client abort, and forced `session/close` (`cognition.ai/force`).
- **Zero dependencies** — runs directly on Node.js >= 20.

## Requirements

- Node.js >= 20 (tested on Node 24)
- Authenticated Devin CLI (`devin auth status` active; auto-detects `devin.exe` from OpenBot runtimes or `PATH`)

## Installation & Run

```bash
git clone https://github.com/Pancakecreates/AI-Anthropic-Proxy.git
cd AI-Anthropic-Proxy
cp .env.example .env
npm start
```

On Windows you can also run `start-proxy.bat`.

## Configuration

| Variable / Flag | Default | Description |
| --- | --- | --- |
| `PORT` / `--port` | `8787` | HTTP listen port |
| `HOST` / `--host` | `127.0.0.1` | HTTP bind host |
| `DEVIN_CWD` / `--cwd` | User home | Workspace directory passed to Devin sessions |
| `DEVIN_MODE` / `--mode` | `bypass` | Devin ACP mode: `bypass`, `accept-edits`, `smart`, `ask`, `plan` |
| `DEVIN_MODEL` / `--model` | `swe-2-1-medium` | Fallback model ID when unknown |
| `DEVIN_THOUGHT_LEVEL` / `--thought-level` | — | Default effort level: `medium`, `high`, `max` |
| `DEVIN_SHOW_TOOLS` / `--show-tools` | `thinking` | Where to emit Devin tool status: `thinking`, `text`, `none` |
| `DEVIN_PROCESS_MODEL` / `--process-model` | `in-process` | Devin process model: `in-process` or `daemon` |
| `PROXY_API_KEY` / `--api-key` | — | Optional API key (`x-api-key` or `Authorization: Bearer ...`) |
| `DEVIN_MODEL_MAP` | `{}` | JSON map from client model ID to Devin model ID |

## Connect to Claude Desktop

1. Open **Claude Desktop**.
2. Enable Developer Mode: **Help -> Troubleshooting -> Enable Developer Mode**.
3. Open **Developer -> Configure Third-Party Inference**.
4. Set **Inference Provider** to **Gateway**:
   - **Gateway Base URL**: `http://127.0.0.1:8787`
   - **API Key**: any string (or your `PROXY_API_KEY`)

### Using non-Claude models (e.g. DeepSeek, Gemini, GPT, SWE)

You can use **any** model supported by your Devin account:

- **Option A (Auto-discovery):** Leave *Override the auto-discovered model list* off so Claude Desktop fetches `/v1/models`.
- **Option B (Manual model list in Claude Desktop):** Turn on *Override the auto-discovered model list* and fill:
  - **Model ID**: `deepseek-v4-pro-high` (or `deepseek-v4-1-flash-1017-high`, `gemini-4-carbon-medium`, `gpt-6-2-astra-medium`, `swe-2-1-medium`)
  - **Display name**: `DeepSeek V4 Pro`
  - **Claude model behind this ID**: `claude-sonnet-4-6` (used only by Claude Desktop UI for effort levels and limits; the proxy still routes `Model ID` directly to DeepSeek in Devin)
- **Option C (`DEVIN_MODEL_MAP`):** Map any Claude ID in `.env` (for example `DEVIN_MODEL_MAP={"claude-opus-4":"deepseek-v4-pro-high"}`).

## Connect to Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "devin-local"
  }
}
```

## Tests

```bash
npm test
```
