# Editions

Agent Rishi ships as two editions built from this one repository ([docs/foundation.md](../docs/foundation.md) §1):

| Edition | Folder | For | Platforms |
|---|---|---|---|
| **Solo** | [`solo/`](solo) | One person runs a whole company, technical and business work, with virtual agent teams | Windows, Linux |
| **Enterprise** | [`enterprise/`](enterprise) | Each department head runs their own virtual team for technical work, with the models the company allows | Linux |

Everything else (`apps/*`, `packages/*`) is the **Foundation** both editions share.

## Rules

1. **The Foundation never imports an edition.** `biome check` (`pnpm lint`) refuses an import of `@agent-rishi/edition-*` from `apps/` or `packages/`.
2. **Edition-specific code lives here only.** The Foundation has no `if (edition === …)`. An edition describes itself with an `EditionConfig` (`packages/contracts/src/edition.ts`) and supplies its own templates, profiles, screens and branding.
3. **Every change is checked against both editions.** Their tests run with `pnpm test`, like every other package.

A fix to the Foundation is made once and reaches both editions. Building and releasing per edition (`pnpm release … --edition`) comes later in the Foundation's order (F16).
