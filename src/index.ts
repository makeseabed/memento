import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfig } from "./config.js";
import { resolveMementoPaths } from "./paths.js";
import { registerObserverTool } from "./observer/tools.js";
import { registerHooks } from "./hooks.js";
import { registerContextEngine } from "./context-engine.js";
import { logStartupBannerOnce } from "./utils/startup-banner.js";

export default definePluginEntry({
  id: "memento",
  name: "Memento",
  description: "Observational memory for OpenClaw.",
  configSchema: {
    parse(value: unknown) {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return resolveConfig(raw);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, "main");
    const { backupDir } = resolveMementoPaths(workspaceDir, "main", { scope: "shared" });
    const setupDirs = [mkdir(backupDir, { recursive: true })];

    Promise.all(setupDirs).catch((err: unknown) =>
      api.logger.warn(`[memento] directory setup failed: ${String(err)}`)
    );

    logStartupBannerOnce({
      log: (msg) => api.logger.info(msg),
      message: `Memento v${(api as unknown as { version?: string }).version ?? "dev"} loaded`,
    });

    registerObserverTool(api, config);
    registerHooks(api, config);
    registerContextEngine(api, config);
  },
});
