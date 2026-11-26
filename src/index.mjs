#!/usr/bin/env node
import { AcpClient } from "./acp-client.mjs";
import { helpText, loadConfig } from "./config.mjs";
import { createProxyServer } from "./server.mjs";
import { SessionManager } from "./sessions.mjs";

async function main() {
  const config = loadConfig();
  if (config.help) {
    process.stdout.write(helpText());
    return;
  }

  const acp = new AcpClient(config);
  const sessions = new SessionManager(acp, config);
  const server = createProxyServer({ config, acp, sessions });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const baseUrl = `http://${config.host}:${config.port}`;
  console.log(`AI-Anthropic-Proxy listening on ${baseUrl}`);
  console.log(`Devin CLI: ${config.devinPath}`);
  console.log(`Workspace CWD: ${config.cwd} (mode: ${config.mode})`);

  try {
    const catalog = await sessions.warmUp();
    console.log(`Devin ACP ready. Loaded ${catalog.models.length} models.`);
  } catch (err) {
    console.warn(`Warning during Devin warmup (will retry on first request): ${err?.message || err}`);
  }

  console.log(`\nClaude Desktop (Developer Mode -> Configure Third-Party Inference):`);
  console.log(`  Provider: Gateway`);
  console.log(`  Gateway Base URL: ${baseUrl}`);
  console.log(`  API Key: any string (or your PROXY_API_KEY)`);
  console.log(`\nClaude Code (~/.claude/settings.json or shell env):`);
  console.log(`  ANTHROPIC_BASE_URL=${baseUrl}`);
  console.log(`  ANTHROPIC_AUTH_TOKEN=devin-local`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    await new Promise((resolve) => server.close(() => resolve()));
    await sessions.closeAll();
    await acp.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
