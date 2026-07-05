# Changelog

## 1.1.0 (fork)

- Add `turn/steer` support: `/codex:steer <job-id> -- <correction>` steers the active
  turn of a running background job; the shared broker now lets `turn/steer` through
  during an active stream, same as `turn/interrupt`.
- Add token-efficient thread viewers: `/codex:threads`, `/codex:thread`, `/codex:turns`,
  `/codex:items` with pagination, type filters, and hard output budgets, backed by
  `thread/list`, `thread/read`, and experimental `thread/turns/list` (with a
  `thread/read` fallback for older Codex CLIs).
- Add `/codex:tail` (bounded job log tail) and `/codex:alerts` (stall, repeated command
  failure, error, and long-runtime drift detection with suggested actions).
- Add `/codex:continue <thread-id>` for explicit follow-up turns on a known thread.
- Enable the `experimentalApi` capability on app-server connections to unlock the
  experimental read APIs.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
