const STARTUP_BANNER_STATE = Symbol.for("@memento/startup-banner-state");

interface StartupBannerState {
  emitted: Set<string>;
}

function getStartupBannerState(): StartupBannerState {
  const g = globalThis as unknown as Record<symbol, StartupBannerState>;
  if (!g[STARTUP_BANNER_STATE]) {
    g[STARTUP_BANNER_STATE] = { emitted: new Set() };
  }
  return g[STARTUP_BANNER_STATE];
}

export function logStartupBannerOnce(params: {
  key?: string;
  log: (message: string) => void;
  message: string;
}): void {
  const key = params.key ?? "memento:startup";
  const state = getStartupBannerState();
  if (state.emitted.has(key)) return;
  state.emitted.add(key);
  params.log(params.message);
}
