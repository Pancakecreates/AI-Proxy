# AI-Anthropic-Proxy

Local Anthropic Messages API (`GET /v1/models`, `POST /v1/messages`, `POST /v1/messages/count_tokens`) proxy backed by Cognition Devin CLI over ACP (`devin acp`). Written in strict **TypeScript** for **Node.js** so you can connect Claude Desktop (Third-Party Inference) or Claude Code directly to your local Devin agent and any model in your Devin account (Claude, DeepSeek, GPT, Gemini, SWE, Grok, Kimi, GLM).

## Features

- **TypeScript codebase** — strictly typed ACP JSON-RPC 2.0 client, Anthropic Messages API handler, and session manager (`src/*.ts` -> `dist/*.js`).
- **Anthropic Messages API compatible** — implements `POST /v1/messages` (streaming SSE with `ping` keepalive + `thinking` blocks, and non-streaming JSON), `GET /v1/models` (with `max_input_tokens`, `max_tokens`, `capabilities`, `line`), and `POST /v1/messages/count_tokens`.
- **Full per-model effort & speed control** — maps Anthropic `output_config.effort`, `thinking.budget_tokens`, and model suffixes (`-none`, `-low`, `-medium`, `-high`, `-xhigh`, `-max`, `-fast`, `-lightning`) to each model's live `thought_level` and `speed` options in `devin acp`.
- **Any model via Devin ACP** — automatically discovers your full Devin model catalog (`121+` base models) and resolves exact IDs, `[1m]` suffixes, Anthropic aliases (`claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`), fuzzy names (`deepseek`, `gemini`, `swe`), or custom `DEVIN_MODEL_MAP` overrides.
- **Stateful session continuation** — matches incoming stateless `messages[]` prefixes onto open Devin ACP sessions and switches models, efforts, and speeds dynamically via `session/set_config_option`.

## Requirements

- Node.js >= 20 (tested on Node 24)
- Authenticated Devin CLI (`devin auth status` active; auto-detects `devin.exe` from OpenBot runtimes or `PATH`)

## Installation & Run

```bash
git clone https://github.com/Pancakecreates/AI-Anthropic-Proxy.git
cd AI-Anthropic-Proxy
npm install
cp .env.example .env
npm run build
npm start
```

### Development mode (no build step)

```bash
npm run dev
```

### Windows quick start

Double-click or run `start-proxy.bat` (automatically runs `npm install` and `npm run build` on first launch, then starts `node dist/index.js`).

## Configuration

| Variable / Flag | Default | Description |
| --- | --- | --- |
| `PORT` / `--port` | `8787` | HTTP listen port |
| `HOST` / `--host` | `127.0.0.1` | HTTP bind host |
| `DEVIN_CWD` / `--cwd` | User home | Workspace directory passed to Devin sessions |
| `DEVIN_MODE` / `--mode` | `bypass` | Devin ACP mode: `bypass`, `accept-edits`, `smart`, `ask`, `plan` |
| `DEVIN_MODEL` / `--model` | `swe-2-1-medium` | Fallback model ID when unknown |
| `DEVIN_THOUGHT_LEVEL` / `--thought-level` | — | Default effort: `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `DEVIN_SPEED` / `--speed` | — | Default speed: `standard`, `fast`, `ultrafast` |
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
   - **API Key**: your `PROXY_API_KEY` from `.env` (or any string if `PROXY_API_KEY` is unset)

### Using non-Claude models & specific efforts (e.g. DeepSeek, Gemini, GPT, SWE)

- **Auto-discovery:** Leave *Override the auto-discovered model list* off so Claude Desktop queries `GET /v1/models`, then pick efforts via Claude's effort slider (`output_config.effort`).
- **Manual model list in Claude Desktop:** Turn on *Override the auto-discovered model list* and fill:
  - **Model ID**: `deepseek-v4-pro-high` (or effort-pinned like `deepseek-v4-pro-max`, `swe-2-1-xhigh`, `swe-2-1-xhigh-lightning`)
  - **Display name**: `DeepSeek V4 Pro`
  - **Claude model behind this ID**: `claude-sonnet-4-6` (used only by Claude Desktop UI for effort levels and limits; the proxy routes `Model ID` directly to DeepSeek in Devin)
- **Custom mapping (`DEVIN_MODEL_MAP`):** Map any Claude ID in `.env` (for example `DEVIN_MODEL_MAP={"claude-opus-4":"deepseek-v4-pro-max"}`).

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

## Scripts

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile src/*.ts -> dist/*.js
npm test            # run tsx --test test/*.test.ts
npm run dev         # run directly via tsx
npm start           # run compiled dist/index.js
```
