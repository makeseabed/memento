export const FALLBACK_AGENT_ID = "main";

type MaybeAgentContext = {
  agentId?: string;
  sessionKey?: string;
} | null | undefined;

export function resolveAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  const value = sessionKey?.trim();
  if (!value) return undefined;
  const parts = value.split(":");
  if (parts[0] === "agent" && parts[1]) return parts[1];
  return undefined;
}

export function resolveCurrentSessionKey(context?: MaybeAgentContext): string | undefined {
  const value = context?.sessionKey?.trim();
  return value || undefined;
}

export function resolveCurrentAgentId(
  _apiOrConfig: { config?: unknown } | unknown,
  context?: MaybeAgentContext
): string {
  const explicitAgentId = context?.agentId?.trim();
  if (explicitAgentId) return explicitAgentId;

  return resolveAgentIdFromSessionKey(context?.sessionKey) ?? FALLBACK_AGENT_ID;
}
