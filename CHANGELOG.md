# Changelog

## 0.2.0
Fix: inject shared and session observations through OpenClaw's session-aware prompt hook.

Fix: restore deterministic observation routing by tagging every observation with its source session and routing shared memory by durable type (`rule`, `preference`, `habit`).

Fix: invalidate the observation prompt cache after watcher/observer runs so new observations are available on the next turn.

Improve: harden observer and reflector prompts to preserve metadata, avoid invented types, and prevent reflector-added structure.

Change: increase the default watcher threshold from 10 to 20 meaningful assistant replies.

## 0.1.2
Fix: resolve install scanner false positive triggered by log string containing word "post".

## 0.1.1
Fix: resolve false-positive dangerous-code scanner flag on install.

## 0.1.0
Initial release.
