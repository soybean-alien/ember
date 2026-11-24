# ADR-0001: No runtime packages

**Status:** Accepted 11/22/2026. Exceptions clarified by the owner 11/23/2026.

## Context

Keep Ember lean and fast, with no dependency drift. Each agent session that adds one reasonable package moves the app further from that, and no one ever decides it on purpose.

## Decision

- Ember uses only Node's built-in modules, including the built-in SQLite (`node:sqlite`).
- Dev-only tools such as test runners and linters are allowed, in `devDependencies` only.
- Any runtime package needs the owner's approval first. An agent that thinks it needs one stops and asks; it does not add it.
- In `package.json` terms: `dependencies` stays empty unless the owner has approved an entry.

## Consequences

- Nothing to install or update, fast start-up, no supply-chain risk.
- Any agent or person can read the whole stack without learning a library.
- Some features take more hand-written code (for example date parsing or CSV export).
- Agents will keep being tempted by a package. This record is what tells them not to.
