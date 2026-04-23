import { Type, type Static } from "@sinclair/typebox";

// ── Sub-schemas ────────────────────────────────────────────────────────────

export const ObserverConfigSchema = Type.Object({
  maxSessions: Type.Optional(Type.Number()),
  maxLinesPerTranscript: Type.Optional(Type.Number()),
  existingObservationsContext: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
});

export const WatcherConfigSchema = Type.Object({
  turnThreshold: Type.Optional(Type.Number()),
});

export const ReflectorConfigSchema = Type.Object({
  triggerWordThreshold: Type.Optional(Type.Number()),
  backupRetentionCount: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
});

export const MemoryFlushConfigSchema = Type.Object({
  flushLookbackHours: Type.Optional(Type.Number()),
  recoverLookbackHours: Type.Optional(Type.Number()),
  skipDedup: Type.Optional(Type.Boolean()),
});

// ── Root schema ────────────────────────────────────────────────────────────

export const MementoConfigSchema = Type.Object({
  model: Type.Optional(Type.String()),
  observer: Type.Optional(ObserverConfigSchema),
  watcher: Type.Optional(WatcherConfigSchema),
  reflector: Type.Optional(ReflectorConfigSchema),
  memoryFlush: Type.Optional(MemoryFlushConfigSchema),
  logging: Type.Optional(Type.Boolean()),
});

export type MementoRawConfig = Static<typeof MementoConfigSchema>;

// ── Resolved config (all fields present) ──────────────────────────────────

export interface ResolvedObserverConfig {
  maxSessions: number;
  maxLinesPerTranscript: number;
  existingObservationsContext: number;
  model?: string;
}

export interface ResolvedWatcherConfig {
  turnThreshold: number;
}

export interface ResolvedReflectorConfig {
  triggerWordThreshold: number;
  backupRetentionCount: number;
  model?: string;
}

export interface ResolvedMemoryFlushConfig {
  flushLookbackHours: number;
  recoverLookbackHours: number;
  skipDedup: boolean;
}

export interface ResolvedMementoConfig {
  model?: string;
  observer: ResolvedObserverConfig;
  watcher: ResolvedWatcherConfig;
  reflector: ResolvedReflectorConfig;
  memoryFlush: ResolvedMemoryFlushConfig;
  logging: boolean;
}

// ── Default values ─────────────────────────────────────────────────────────

export const DEFAULTS: ResolvedMementoConfig = {
  model: undefined,
  observer: {
    maxSessions: 10,
    maxLinesPerTranscript: 300,
    existingObservationsContext: 40,
    model: undefined,
  },
  watcher: {
    turnThreshold: 20,
  },
  reflector: {
    triggerWordThreshold: 8000,
    backupRetentionCount: 10,
    model: undefined,
  },
  memoryFlush: {
    flushLookbackHours: 2,
    recoverLookbackHours: 4,
    skipDedup: true,
  },
  logging: false,
};

// ── Env-override helpers ───────────────────────────────────────────────────

export function toStr(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  return undefined;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = parseFloat(v);
    if (isFinite(n)) return n;
  }
  return undefined;
}

export function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

// ── resolveConfig ──────────────────────────────────────────────────────────

export type MementoEnv = Readonly<Record<string, string | undefined>>;

export function resolveConfig(raw: unknown, env: MementoEnv = {}): ResolvedMementoConfig {
  const c = ((raw ?? {}) as MementoRawConfig);
  const d = DEFAULTS;
  const sharedModel = toStr(env.MEMENTO_MODEL) ?? c.model ?? d.model;

  return {
    model: sharedModel,
    observer: {
      maxSessions: toNumber(env.MEMENTO_OBSERVER_MAX_SESSIONS) ?? c.observer?.maxSessions ?? d.observer.maxSessions,
      maxLinesPerTranscript: toNumber(env.MEMENTO_OBSERVER_MAX_LINES_PER_TRANSCRIPT) ?? c.observer?.maxLinesPerTranscript ?? d.observer.maxLinesPerTranscript,
      existingObservationsContext: toNumber(env.MEMENTO_OBSERVER_EXISTING_OBS_CONTEXT) ?? c.observer?.existingObservationsContext ?? d.observer.existingObservationsContext,
      model: toStr(env.MEMENTO_OBSERVER_MODEL) ?? c.observer?.model ?? sharedModel,
    },
    watcher: {
      turnThreshold: toNumber(env.MEMENTO_WATCHER_TURN_THRESHOLD) ?? c.watcher?.turnThreshold ?? d.watcher.turnThreshold,
    },
    reflector: {
      triggerWordThreshold: toNumber(env.MEMENTO_REFLECTOR_TRIGGER_WORD_THRESHOLD) ?? c.reflector?.triggerWordThreshold ?? d.reflector.triggerWordThreshold,
      backupRetentionCount: toNumber(env.MEMENTO_REFLECTOR_BACKUP_RETENTION_COUNT) ?? c.reflector?.backupRetentionCount ?? d.reflector.backupRetentionCount,
      model: toStr(env.MEMENTO_REFLECTOR_MODEL) ?? c.reflector?.model ?? sharedModel,
    },
    memoryFlush: {
      flushLookbackHours: toNumber(env.MEMENTO_MEMORY_FLUSH_LOOKBACK_HOURS) ?? c.memoryFlush?.flushLookbackHours ?? d.memoryFlush.flushLookbackHours,
      recoverLookbackHours: toNumber(env.MEMENTO_MEMORY_RECOVER_LOOKBACK_HOURS) ?? c.memoryFlush?.recoverLookbackHours ?? d.memoryFlush.recoverLookbackHours,
      skipDedup: toBool(env.MEMENTO_MEMORY_FLUSH_SKIP_DEDUP) ?? c.memoryFlush?.skipDedup ?? d.memoryFlush.skipDedup,
    },
    logging: toBool(env.MEMENTO_LOGGING) ?? toBool(env.MEMENTO_LOG_FILE_ENABLED) ?? c.logging ?? d.logging,
  };
}
