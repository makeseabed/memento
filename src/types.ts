/**
 * Local type extensions for Memento.
 * The main plugin API type is OpenClawPluginApi from openclaw/plugin-sdk.
 */

/** Minimal shape of an assistant message content block, for casting the SDK's `messages: unknown[]`. */
export interface SubagentMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}
