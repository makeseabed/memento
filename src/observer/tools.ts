import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { ResolvedMementoConfig } from "../config.js";
import { runObserver } from "./observer.js";

export function registerObserverTool(api: OpenClawPluginApi, config: ResolvedMementoConfig): void {
  api.registerTool(
    (_ctx) =>
      ({
        name: "memento_observe",
        description: "Manually trigger a Memento observation pass",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["normal", "flush"],
              description: "Observation mode: normal (default) or flush (extended lookback)",
            },
          },
        },
        async execute(params: Record<string, unknown>) {
          const mode = params["mode"] as "normal" | "flush" | undefined;
          await runObserver(api, config, {
            flushMode: mode === "flush",
            triggerTag: "[manual]",
          });
          return { content: [{ type: "text", text: "Observer run complete" }] };
        },
      }) as unknown as AnyAgentTool,
    { optional: true }
  );
}
