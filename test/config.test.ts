import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULTS } from "../src/config.js";

// Helper: call resolveConfig with isolated env (no real process.env leaking in)
function resolveWithEnv(raw: unknown, env: Record<string, string>): ReturnType<typeof resolveConfig> {
  return resolveConfig(raw, env as NodeJS.ProcessEnv);
}

describe("resolveConfig", () => {
  it("fills all defaults when called with empty input", () => {
    const cfg = resolveConfig({});
    expect(cfg).toEqual(DEFAULTS);
  });

  it("fills all defaults when called with undefined", () => {
    const cfg = resolveConfig(undefined);
    expect(cfg).toEqual(DEFAULTS);
  });

  it("overrides individual observer fields while keeping the rest at defaults", () => {
    const cfg = resolveConfig({ observer: { maxSessions: 5 } });
    expect(cfg.observer.maxSessions).toBe(5);
    expect(cfg.observer.model).toBeUndefined();
  });

  it("overrides watcher turnThreshold", () => {
    const cfg = resolveConfig({ watcher: { turnThreshold: 5 } });
    expect(cfg.watcher.turnThreshold).toBe(5);
  });

  it("overrides reflector triggerWordThreshold", () => {
    const cfg = resolveConfig({ reflector: { triggerWordThreshold: 5000 } });
    expect(cfg.reflector.triggerWordThreshold).toBe(5000);
    expect(cfg.reflector.model).toBeUndefined();
  });

  it("leaves models unset by default so OpenClaw resolves them", () => {
    const cfg = resolveConfig({});
    expect(cfg.model).toBeUndefined();
    expect(cfg.observer.model).toBeUndefined();
    expect(cfg.reflector.model).toBeUndefined();
  });

  it("uses shared top-level model when component overrides are absent", () => {
    const cfg = resolveConfig({ model: "anthropic/claude-haiku-4-5" });
    expect(cfg.model).toBe("anthropic/claude-haiku-4-5");
    expect(cfg.observer.model).toBe("anthropic/claude-haiku-4-5");
    expect(cfg.reflector.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("prefers component model override over shared top-level model", () => {
    const cfg = resolveConfig({
      model: "anthropic/claude-haiku-4-5",
      observer: { model: "anthropic/claude-opus-4-6" },
    });
    expect(cfg.observer.model).toBe("anthropic/claude-opus-4-6");
    expect(cfg.reflector.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("default memoryFlush skipDedup is true", () => {
    const cfg = resolveConfig({});
    expect(cfg.memoryFlush.skipDedup).toBe(true);
  });

  it("defaults file logging to disabled", () => {
    const cfg = resolveConfig({});
    expect(cfg.logging).toBe(false);
  });
});

describe("resolveConfig env overrides", () => {
  it("env MEMENTO_MODEL sets the shared model", () => {
    const cfg = resolveWithEnv({}, { MEMENTO_MODEL: "anthropic/claude-opus-4-6" });
    expect(cfg.model).toBe("anthropic/claude-opus-4-6");
    expect(cfg.observer.model).toBe("anthropic/claude-opus-4-6");
    expect(cfg.reflector.model).toBe("anthropic/claude-opus-4-6");
  });

  it("env MEMENTO_OBSERVER_MODEL overrides shared config and env", () => {
    const cfg = resolveWithEnv(
      { model: "anthropic/claude-haiku-4-5" },
      {
        MEMENTO_MODEL: "anthropic/claude-sonnet-4-5",
        MEMENTO_OBSERVER_MODEL: "anthropic/claude-opus-4-6",
      }
    );
    expect(cfg.observer.model).toBe("anthropic/claude-opus-4-6");
    expect(cfg.reflector.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("env MEMENTO_REFLECTOR_MODEL overrides shared config and env", () => {
    const cfg = resolveWithEnv(
      { model: "anthropic/claude-haiku-4-5" },
      {
        MEMENTO_MODEL: "anthropic/claude-sonnet-4-5",
        MEMENTO_REFLECTOR_MODEL: "anthropic/claude-opus-4-6",
      }
    );
    expect(cfg.observer.model).toBe("anthropic/claude-sonnet-4-5");
    expect(cfg.reflector.model).toBe("anthropic/claude-opus-4-6");
  });

  it("component config takes precedence over shared config when no env override", () => {
    const cfg = resolveWithEnv(
      { model: "shared/model", observer: { model: "custom/model" } },
      {}
    );
    expect(cfg.observer.model).toBe("custom/model");
  });

  it("toNumber handles string numeric values", () => {
    const cfg = resolveWithEnv({}, { MEMENTO_OBSERVER_MAX_SESSIONS: "5" });
    expect(cfg.observer.maxSessions).toBe(5);
  });

  it("env MEMENTO_LOGGING overrides config", () => {
    const cfg = resolveWithEnv({ logging: false }, { MEMENTO_LOGGING: "true" });
    expect(cfg.logging).toBe(true);
  });

  it("legacy env MEMENTO_LOG_FILE_ENABLED still overrides config", () => {
    const cfg = resolveWithEnv({ logging: false }, { MEMENTO_LOG_FILE_ENABLED: "true" });
    expect(cfg.logging).toBe(true);
  });
});
