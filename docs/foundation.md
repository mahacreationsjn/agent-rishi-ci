# Agent Rishi Foundation and editions

> Status: **proposed**, 2026-11-27. Not in force until the owner approves it by merging. Once approved, the "Changes to Locked decisions" in §14 are carried into [DESIGN.md](DESIGN.md) section by section as each part is built, and this file records what is still to come.

Agent Rishi grows into two editions built on one shared base:

- **Solo:** one person runs a whole company, technical and business work, with virtual agent teams. It ships for **Windows and Linux**.
- **Enterprise:** in a company, each department has one person who builds and runs their own virtual agent team for technical and development work. The company decides which models each department may use. It ships for **Linux only**.

Both need the same base, the **Foundation**, which this document designs. The editions themselves are designed later, once the Foundation is in place. Agent Rishi stays local-first: nothing here adds accounts or a hosted backend. Every agent works for one person, its owner, and can never do more than that owner allows.

## 1. Repository layout: one repository, two editions

One repository holds the Foundation and both editions:

```
packages/          Foundation: contracts, providers, vault, teams, policy, ...
apps/              server, runner, web, desktop (shared)
editions/
  solo/            Solo's templates, profiles, screens and branding
  enterprise/      Enterprise's templates, profiles, profile lock, department setup, branding
```

Rules that keep it sound:

1. **The Foundation never imports an edition.** Editions use the Foundation, never the other way round. A lint rule enforces it.
2. **Edition-specific code lives in `editions/` only.** The Foundation has no `if (edition === …)`. An edition switches features on and off and supplies defaults through one `EditionConfig` (features, built-in templates, default profiles, branding).
3. **Every change is checked against both editions** (`pnpm verify`, CI).
4. **Releases are per edition:** `pnpm release <bump> --edition solo` builds Windows (from a Windows machine) and Linux installers; `--edition enterprise` builds Linux only.

A fix to the Foundation is made once and reaches both editions. If an Enterprise copy without Solo's code is ever needed, it is exported from the same repository (the tree without `editions/solo`); development stays in one place.

## 2. Ownership and scope

Every stored thing that someone owns gets two fields now, before there is more than one person:

- `owner`: who it belongs to. In both editions today there is exactly one: the person using this install.
- `scope`: `personal`, `team` or `company`.

Secrets, connections, profiles, role templates and teams carry them. Nothing checks them across people yet; they exist so that Enterprise can later hold company-provided items (usable, not readable) without a data migration.

## 3. Vault

The Vault holds the secrets agents use. **Agent Rishi puts a secret where it is needed; the model never sees its value.**

### 3.1 Items

| Kind | Example | Where Agent Rishi applies it | When |
|---|---|---|---|
| `api-credential` | A model provider's API key | The environment of the session process that uses the connection, or a header the server adds | First |
| `env-secret` | A database URL, an MCP server's token | The environment of the chosen project's sessions or MCP server, nothing else | Second |
| `login` (optional TOTP key) | A staging dashboard | Typed into the matching sign-in form by the runner's browser, never by the agent | Later |

Payment cards are not stored.

### 3.2 Storage

- Items are encrypted with AES-256-GCM in Agent Rishi's data folder. Each value's associated data binds it to its item id, owner and purpose, so a copied value doesn't decrypt elsewhere.
- Only the data key lives in the OS keychain (through the existing `SecretStore`).
- **Fail closed.** A missing or wrong key stops the Vault; it never overwrites or re-creates data it can't read. Unreadable items can still be deleted.
- Storage sits behind an interface, so a company can later plug in its own secret manager.

### 3.3 Grants: applied automatically, still the owner's decision

- A role template (§9) lists the items its sessions may use. **Granting an item there is the owner's consent;** sessions in that role then get it without asking each time.
- A grant has bounds: which role, which project, which destination (connection, origin or MCP server) and for how long.
- A session that needs an item it wasn't granted asks in the Inbox and waits.
- Logins are used only on their saved origin (scheme, host and port), after the runner checks the real origin of the form's frame.

### 3.4 Keeping values out of everything else

- **Redaction before storage.** The event log is append-only, so a value that reached it could never be removed. The runner and the server replace every known Vault value in tool output, transcripts, notices and exports before they are stored or shown.
- Screenshots mask password fields and known values.
- No tool returns a value to an agent.
- **Audit.** Every use, grant, reveal and change is an event, without the value.
- Import from a password manager's CSV export, with a reminder to delete the file afterwards.

Agent Rishi itself can read a value while it applies it, and a website keeps what is submitted to it; the Vault keeps values away from models, logs and transcripts, not from Agent Rishi or the destination.

## 4. Connections

A **harness** runs an agent (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Antigravity CLI). A **connection** is the account it runs on: whose login or key, and who pays.

| Kind | Meaning |
|---|---|
| `subscription` | The CLI's own login, as today |
| `api-key` | A provider API key from the Vault |
| `cloud` | A cloud platform account |
| `compatible` | Any endpoint that speaks the OpenAI-compatible API, with a base URL |

### 4.1 Providers

| Provider | As an agent | Model list |
|---|---|---|
| Anthropic | Claude Code with an API key | The provider's models endpoint |
| OpenAI | Codex with an API key | The provider's models endpoint |
| Gemini | Gemini CLI with an API key | The provider's models endpoint |
| xAI | OpenCode, OpenAI-compatible | The provider's models endpoint |
| Sarvam AI | OpenCode, OpenAI-compatible, only for models that pass the tool-use check | The provider's models endpoint |
| Local models (Ollama, LM Studio, vLLM) | OpenCode, OpenAI-compatible | The server's models endpoint |

More are added the same way.

### 4.2 Rules

- **Model names are never hard-coded.** Each connection lists its models live; providers rename and retire models often.
- **Capabilities are probed, not assumed.** A model counts as able to run agents only after a small tool-call check passes; others are offered for chat-like work only.
- A connection's key reaches only the session that uses it. Agent Rishi never overwrites a CLI's own login: a key-based Codex session, for example, runs with its own private Codex home.
- Subscription connections keep working as they do today.

### 4.3 One detection, with "verified"

Today the setup checklist and the runner's `detect()` are two separate implementations that can disagree, which is how a provider can show as ready and still fail. There will be one detection, in the runner, which setup displays. Each connection reports one of three levels:

1. **configured:** installed, or a key and base URL are set;
2. **credential found:** there is evidence of a login or key;
3. **verified:** a real check passed (a protocol handshake, or a models request that costs no tokens), with the time it passed.

Only **verified** shows as ready. Gemini CLI gets its model list before a session starts, as Antigravity CLI does.

## 5. Capabilities and model profiles

Each model is tagged with what it can do: `code-agent`, `reasoning`, `chat`, `indic`, `speech`, `image`, `video`, `utility`.

A **model profile** is a file that names the models allowed for each capability. Each install uses one profile. Solo's default profile allows everything its connections offer. In Enterprise the company writes a profile per department and can **lock** it; the lock is an Enterprise feature, the profile format is Foundation. Model pickers, role templates and routing only offer what the profile allows.

## 6. Routing

Each role has an ordered list of (connection, model) choices drawn from the profile. When one is unavailable (not verified, at a usage limit, over budget) the next is used, never a provider's default by accident, and the session says why it moved. The utility model's fixed order (Claude, then Codex, then OpenCode) becomes a routing list like any other.

## 7. Policy: kinds of actions that always need a person

Approvals today classify commands, file access and fetches. The Foundation adds action kinds that, at every autonomy level, need the owner's approval (§11.2 levels still apply to everything else):

| Kind | Examples |
|---|---|
| `money` | Anything that pays, transfers, buys or refunds. Agents never move money themselves |
| `outbound-message` | Email, chat or social messages to people |
| `publish` | Posting content, releasing, publishing packages |
| `deploy` | Changing a running service or server |
| `secret-use` | Using a Vault item outside its grant |
| `destructive` | Deleting data that can't be recovered |

Tools declare the kind of what they do; integrations (§11) must declare it to be enabled.

## 8. Usage and budgets

- Prices per model and connection: API connections show actual spend, subscriptions an "API-equivalent" estimate, as today.
- Spend is broken down by role, team, project and connection.
- **Budgets** per run, role, team and month. Reaching one stops new work there and asks in the Inbox.
- The known usage errors are fixed here, since budgets depend on them: missing prices for Codex and Antigravity models, the opus alias, and the daily average.

## 9. Role templates and teams

### 9.1 Role templates

A role template defines one virtual teammate:

- name and purpose (instructions);
- model: a capability plus a preference (cheaper, stronger, or a different provider from another role);
- rights: read the repository, write code, use the web and browser, create GitHub issues, and so on;
- Vault grants;
- budget;
- the shape of its report (named fields the next role reads).

Today's fixed roles (orchestrator, project manager, agent, and the factory's roles) become **built-in templates** on the same engine, so they keep their behaviour and tools while new roles are added alongside them. MCP tokens stay role-scoped; the role now names a template.

### 9.2 Teams

A team is a set of roles and a flow:

- **steps** in order;
- **loops** between two roles until one approves, with a maximum count;
- **gates** where the owner approves before the flow continues (for example a plan and its budget);
- limits (cost per run).

Each project can run teams. Its project manager leads them. Every step's report is a structured item in the project's history and in the Inbox.

Templates and teams are files (`.agent-rishi/teams/<name>.yaml` in a repository, or in the data folder), so they can be versioned, reviewed and copied.

The first built-in team is a planning team: Researcher → Planner ⇄ Reviewer (on a different provider, at most three rounds) → Budget estimator → owner's approval → Task manager, which turns the plan into GitHub issues for the existing project manager and agents.

## 10. Workspaces without code

A project can be a git repository (as today) or a plain workspace: a folder of documents with the same sessions, teams, history and Inbox, but none of the git and pull-request flow. Planning outputs and, in Solo, business work live there.

## 11. Integrations

External services (mail, calendars, issue trackers, stores) connect as MCP servers whose credentials come from the Vault through grants. Each integration's tools declare their action kind (§7). Integrations are enabled per role.

## 12. Media engines

The image engine interface (§12.5 of DESIGN.md) becomes a general media engine interface with `image`, `video` and `speech` kinds, chosen through capabilities and profiles.

## 13. Reports, notifications and approval channels

- Notices become structured reports a person can read at a glance.
- Desktop notifications for what needs the owner.
- **Approval channels.** An approval can also be answered from a chat app the owner already uses. The first channel is the owner's own Telegram agent. Agent Rishi connects **out** to it, so no new listener opens and the 127.0.0.1 rule holds. Only a summary leaves Agent Rishi (what, why, cost), never secrets, code or transcripts. Each approval carries a signed, single-use token that expires.

## 14. Changes to Locked decisions (DESIGN.md §3)

| Area | Today | Proposed |
|---|---|---|
| Agents | Each provider through its CLI and the user's own login | The same harnesses, plus **connections**: API keys, cloud accounts and OpenAI-compatible endpoints, held in the Vault (§4) |
| Agent ↔ app | Role-scoped tokens for orchestrator, PM and agent | Role-scoped tokens for any role template; the old roles become built-in templates (§9) |
| Utility model | One model setting | A routing list like any role's (§6) |
| Secrets (DESIGN.md §6) | A few keys in the OS keychain; API keys an advanced alternative, never the default ask | The Vault (§3); API keys are a first-class way to connect |
| Platforms | Windows, macOS and Linux; Windows tested first | Linux is first-class (Enterprise is Linux-only and CI runs on Linux); Solo also ships for Windows |
| Repository | About five packages, one npm package | Foundation packages plus `editions/` (§1) |
| First-run setup (DESIGN.md §14) | "API keys are only an advanced alternative, never the default ask" | Subscription and API-key connections are offered side by side |

## 15. Stability work that comes first

- **Data safety.** Regular backups of the database and settings, a tested restore, and an integrity check at startup. An unclean shutdown on the development machine once left zero-filled files in a git checkout; the data folder must survive that.
- **Linux parity.** Linux builds, `pnpm verify` and keyring detection on Linux, and Linux installers, at the same level as Windows today.
- **CI.** Hosted CI is unavailable on the main account. A private mirror repository on another account runs the Linux checks; Windows checks and the Windows installer run on the owner's Windows machine.
- **Flaky tests.** Two web tests fail under load only (`in-place-session-panel.test.tsx`, and a toast timer that outlives its test in `live-effects-toasts.test.tsx`).

## 16. Order

| Step | What | Depends on |
|---|---|---|
| F0 | This design | – |
| F1 | Data safety | – |
| F2 | Linux parity | F3 |
| F3 | CI mirror and flaky tests | – |
| F16a | `editions/` layout, `EditionConfig`, the import rule | F0 |
| F4 | Ownership and scope fields | F0 |
| F5 | Vault core, `api-credential`, grants, redaction, audit | F4 |
| F6 | Connections, one detection with "verified", live model lists, capability probe | F0 |
| F7, F8 | Capabilities and profiles; routing | F6 |
| F9 | Policy action kinds | F0 |
| F10 | Usage and budgets | F6 |
| F11 | Role templates and the team engine | F7–F10 |
| F12 | Workspaces without code | F11 |
| F13, F14, F15 | Integrations; media engines; reports and approval channels | F5, F9, F11 |
| F16 | Edition releases (`--edition`) and the editions' own work | all |

F1, F3 and F16a can start at once; each step lands as one or more pull requests, each checked with `pnpm verify`.

## 17. Open questions

- Enterprise on Linux: the desktop app (AppImage or deb), or the server with the web UI only, or both?
- macOS: keep building it as today, or stop?
- Which secret manager, if any, a company would plug into the Vault.
