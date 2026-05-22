# Changelog

## 0.2.0 - 2026-05-22

Public work-in-progress release focused on making the runtime a usable product
entrypoint rather than a collection of browser scripts.

### Added

- Unified backend router in the main worker.
- `browser_backend_status` / `devtools_backend_status` for agent-readable
  Managed Browser and Personal Chrome availability.
- `backend`, `personal`, `currentTab`, and `useCurrentTab` routing parameters on
  the `browser_*` facade tools.
- Structured `personal_bridge_unavailable` response when an agent asks for the
  user's Chrome tab but the Personal Chrome bridge is not connected.
- Operator-assisted authentication bootstrap for login flows that require human
  completion, 2FA, passkeys, SSO, or anti-abuse scoring.
- Durable profile resume and live-tab adoption diagnostics for long-running
  agent workflows.
- Local feedback notes and GitHub issue templates for bugs, capability gaps, and
  product friction.

### Notes

- Managed Browser/CDP remains the main professional evidence path.
- Personal Chrome is beta and must be explicitly authorized by the local
  operator.
- The project collects objective browser evidence. It does not classify
  vulnerabilities or assign severity.
