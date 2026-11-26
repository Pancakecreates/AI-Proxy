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
| `DEVIN_GATEWAY_ALIASES` / `--no-gateway-aliases` | `true` | Expose non-Claude Devin models under Claude Desktop Gateway-compatible IDs in `/v1/models` (`?raw=1` disables per request) |

## Connect to Claude Desktop

1. Open **Claude Desktop**.
2. Enable Developer Mode: **Help -> Troubleshooting -> Enable Developer Mode**.
3. Open **Developer -> Configure Third-Party Inference**.
4. Set **Inference Provider** to **Gateway**:
   - **Gateway Base URL**: `http://127.0.0.1:8787`
   - **API Key**: your `PROXY_API_KEY` from `.env` (or any string if `PROXY_API_KEY` is unset)

### Using all 121+ models (DeepSeek, GPT, Gemini, SWE, Kimi, GLM, Grok, Claude)

- **Automatic Model discovery (recommended):** Keep **Model discovery** on and **Model list** empty. Because Claude Desktop filters `/v1/models` to Anthropic-looking route IDs and rejects names like `deepseek`, `gpt`, `gemini`, `glm`, `kimi`, `grok`, or `nemotron`, the proxy automatically exposes non-Claude models under reversible `claude-fable-acp-...` gateway aliases while keeping their real `display_name` (such as `DeepSeek V4 Pro`, `GPT-6.2 Astra`, `Gemini 4 Neon`, `SWE-2.1`) and decoding incoming requests (including `[1m]` variants) back to the exact Devin model. Pass `?raw=1` to `/v1/models` or set `DEVIN_GATEWAY_ALIASES=false` (`--no-gateway-aliases`) for raw IDs.
- **Custom mapping (`DEVIN_MODEL_MAP`):** Map any Claude Desktop-compatible ID in `.env` (for example `DEVIN_MODEL_MAP={"anthropic/dp-v4-pro-high":"deepseek-v4-pro-high"}`) if adding custom entries in **Model list**.

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
