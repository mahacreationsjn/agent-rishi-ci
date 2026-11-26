# Agent configuration

Agent Rishi has first-class editors for each provider's **own** configuration: memory files, skills, subagents, MCP servers and hooks. It never keeps a private copy of what your agents load. Edits are written to the native files in place, so they show up in the terminal CLI too, and changes you make in the terminal show up in Agent Rishi.

Open **Agents** from the sidebar or the command palette. It has five tabs: **Memory**, **Skills**, **Subagents**, **MCP servers** and **Hooks**. Pick a project at the top to see its files next to your user-level ones.

![Reviewing a CLAUDE.md change before saving](images/agent-memory.png)

## What's covered

| | Claude Code | Codex |
|---|---|---|
| **Memory (user)** | `~/.claude/CLAUDE.md`, `~/.claude/rules/**/*.md` | `~/.codex/AGENTS.md` (and `AGENTS.override.md`) |
| **Memory (project)** | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, nested `CLAUDE.md` files, `.claude/rules/` | `AGENTS.md` files, including nested ones |
| **Auto memory** | `~/.claude/projects/<project>/memory/` (or `autoMemoryDirectory` from `~/.claude/settings.json`); shared by all of a project's worktrees | |
| **Skills** | `~/.claude/skills/<name>/SKILL.md`, `.claude/skills/` | `~/.codex/skills`, `~/.agents/skills`, `.agents/skills` |
| **Subagents** | `~/.claude/agents/**/*.md`, `.claude/agents/` | `~/.codex/agents/*.toml`, `.codex/agents/` |
| **MCP servers** | user (`~/.claude.json`), local (per project, in `~/.claude.json`), project (`.mcp.json`) | user (`~/.codex/config.toml`) |
| **Hooks** | the `hooks` key of `~/.claude/settings.json` (user), `.claude/settings.json` (project) and `.claude/settings.local.json` (local) | |

Nested scans skip dot-folders and build output.

## Editing safely

- **Diff before save.** Every save shows a diff of what will change, and you confirm it.
- **Backups.** Before any overwrite or delete, the old file (or skill folder) is copied to `~/.agent-rishi/backups/agent-config/`.
- **No lost edits.** If the file changed on disk since you opened it (for example the agent or your terminal edited it), the save is refused instead of overwriting.
- **Atomic writes**, so a crash never leaves a half-written file.
- **Scoped.** The editors only reach known agent-config locations. Anything else, `.git`, credential files and `..` paths are refused.
- **Formatting is kept.** JSON files keep their indentation. In `~/.codex/config.toml` only the server's own `[mcp_servers.<name>]` block is replaced (or the `[[skills.config]]` entries a skill switch changes), and in Claude's `settings.json` files only the `hooks` or `skillOverrides` value is, so your comments and other settings stay byte for byte. Fields Agent Rishi doesn't know about are preserved.

New files start from a sensible template (a skill folder with `SKILL.md`, a subagent with its frontmatter, and so on).

## Skills

The **Skills** tab lists your user skills and, when a project is picked, the project's, for Claude Code and Codex. Create, edit and delete them like any other file.

### Switch skills on and off

Each skill has an on/off switch at the end of its row. Switching a skill off keeps its folder: the agent no longer sees it, and the composer's `/` menu stops offering it. Agent Rishi writes the provider's **own** setting, so the CLI in your terminal follows the switch too:

- **Claude Code:** the `skillOverrides` key of a Claude settings file, which maps a skill name to `"on"`, `"name-only"`, `"user-invocable-only"` or `"off"`. Switching off writes `"off"`. Switching on removes the entry, or writes `"on"` when a less specific file would otherwise still switch the skill off or limit it.
- **Codex:** `[[skills.config]]` entries in `~/.codex/config.toml`, each with `enabled`. Switching off adds an entry with `enabled = false` that selects a user skill by `path` (its `SKILL.md`) and a project skill by `name`, because a project skill's path is different in every worktree. Switching on removes every entry that selects the skill.

**Which file it writes.**

- **Claude Code** reads `~/.claude/settings.json` (user), `.claude/settings.json` (project) and `.claude/settings.local.json` (local), and the most specific file that names a skill decides it: local, then project, then user.
- **The switch edits the file that already decides the skill**, so the change takes effect where it was set. When no file names it, the switch writes your user settings (`~/.claude/settings.json`), which reach every session, worktrees included. The dialog says where the change goes and who it applies to: you in every project, everyone using the repository, or only you in this project.
- **Codex** has one file, `~/.codex/config.toml`, where the last entry that selects a skill decides it.
- **Hover the switch** to see the file that sets the skill's state.

**Diff and backup.** Like every other edit here, a switch shows the diff first, and nothing is written until you confirm. The old file is copied to `~/.agent-rishi/backups/agent-config/` before it's overwritten, and the confirmation names the backup. Only the `skillOverrides` value or the `[[skills.config]]` entries change. Comments in `config.toml` are kept, and a change that would drop one is refused (edit that file by hand instead). A switch is also refused while a settings file that applies can't be parsed, or is a link that leads outside its folder, so Agent Rishi never writes a different file in its place.

**Name-only and user-only.** Claude Code has two states between on and off, which Agent Rishi shows but doesn't set:

- **name-only** (`"name-only"`): Claude sees the skill's name without its description.
- **user-only** (`"user-invocable-only"`): Claude doesn't see the skill, but you can still type `/name`.

Their switch shows **on**, and the row carries the state as a label. Switching such a skill off writes `"off"` in place of the state. Switching it back on removes the entry, so the skill is then fully on; set a partial state again in the settings file.

**What's loaded** in a session's details dims switched-off skills and labels them **off**, judged from the settings files that apply to the session's own folder (see [What's loaded](#whats-loaded)).

## MCP servers

The **MCP servers** tab lists every server each provider will load, by scope, including Agent Rishi's own (`agent-rishi`, read-only). Add, edit or remove a server per provider and scope:

- **stdio:** command, arguments, environment variables and working directory.
- **HTTP or SSE:** URL and headers (Codex can also take the name of an environment variable holding a bearer token).
- **Enabled:** switch a server off without deleting it.

Every change shows its diff first.

### Test a server

**Test** (the plug icon on a server's row, or the **Test** button in the add/edit dialog) checks that a server works before an agent needs it. The dialog tests the values in the form, so you can try a server before you save it. The test runs in the runner, next to your code:

- **stdio** servers are started with their command, arguments and environment, in the project folder (or your home folder for user-scope servers, or the server's own working directory when it has one). Afterwards they are stopped together with anything they started (such as the process behind `npx`), whether the test passed, failed or timed out.
- **HTTP and SSE** servers are reached at their URL with their headers. For Codex, a bearer-token variable and `env_http_headers` are applied too. Header names are matched regardless of case, so each header is sent once: the bearer-token variable wins over `env_http_headers`, which wins over the headers themselves.
- For Claude Code servers, `${VAR}` and `${VAR:-default}` placeholders are filled in from the environment, as Claude Code does. A variable without a default that isn't set fails the test and is named.

Agent Rishi runs the MCP `initialize` handshake and `tools/list` (every page, up to 100), then shows whether it connected, the server's name and version, how many tools it offers with their names, and how long it took. A server with more pages than that shows "more than N tools". If it fails, you see where it stopped (starting, the handshake or listing tools), the error, and the end of the server's error output, which usually names the real problem: a missing package, a missing API key, a typo in the command. A test gives up after 60 seconds, which leaves time for a first `npx` download.

The test can't sign in to servers that need an OAuth login. A `401` says so; sign in from the agent's own CLI instead.

## Hooks

Hooks are commands an agent runs on lifecycle events: before or after a tool call, when you send a prompt, when it stops, at session start and so on. Use them to guard and automate your agents, for example to block risky shell commands or to format files after every edit.

The **Hooks** tab lists the hooks in each settings file, grouped by file (user, plus the project's shared and local files when a project is picked). Each row shows the event, the matcher (`all` when there is none), the type, what it runs and its timeout. You can:

- **Add** a hook: pick the file, the event and an optional matcher (a tool name or regex such as `Edit|Write`; some events ignore it), then the type (**Command**, **HTTP**, **Prompt** or **Agent**), what it runs and an optional timeout in seconds. A hook joins the group with the same matcher, or starts a new one.
- **Edit** a hook. Its other fields (`if`, `statusMessage`, `async`, headers and so on) are kept. Hooks of other types (such as `mcp_tool`) are listed and can be disabled or deleted, but are edited in the file.
- **Disable** a hook. Claude Code has no switch for a single hook, so Agent Rishi takes it out of the settings file and keeps it in `~/.agent-rishi/agent-config/disabled-hooks.json`. It stays in the list, marked **disabled**, and **Enable** writes it back to the same file. The settings file always shows exactly what runs, in Agent Rishi and in the terminal.
- **Delete** a hook. Deleting a disabled hook only removes Agent Rishi's copy.

Only the `hooks` key is written, and matchers keep their exact text. If a file sets `disableAllHooks: true`, the tab says so: none of that file's hooks run. If a file can't be parsed, or the project's `.claude` folder or settings file is a link that leads outside the project (or outside your home, for user settings), the tab shows the error and leaves it alone. The tab appears for providers whose native config has hooks; today that is Claude Code.

### Hook runs in the transcript

When a hook runs during a session, the session's transcript shows it in the turn where it ran. You can see why an agent stopped, retried or got extra context, without opening a terminal. This works for providers that report their hook runs (`capabilities.hookRuns`), which today are Claude Code and Codex. Other providers show nothing new.

Each run is a one-line row: the event (`PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`, `SessionStart` and so on), what ran, how it ended and how long it took. Click the row to see the hook's output and its settings file.

- **What ran.** Claude Code names a hook by its event and the tool it ran for, so a `PreToolUse` hook on a Bash call reads `Bash`. Codex names the handler type (`command`, `MCP tool`, `prompt`, `agent`) and its hooks file.
- **How it ended.** A run is **running**, **ran** (succeeded), **failed** (the hook itself errored), **blocked** or **cancelled**. A run is **blocked** when it stopped what it guards:
  - Claude Code: exit code 2 (a blocking error), or JSON output with `"decision": "block"`, `"continue": false` or a `deny` permission decision.
  - Codex: a run Codex reports as blocked or as having stopped the agent.

  The exit code shows when Claude Code reports it.
- **Failed and blocked runs stand out.** They get a row of their own in the warning colour, with the first line of their reason (the hook's stderr, or Codex's message) shown inline.
- **Busy hooks stay compact.** Runs that succeed sit inside the turn's group of tool calls, so a hook around every tool call doesn't split it, and the group counts them ("4 steps · 6 hooks"). Successful runs one after another fold into one "3 hooks ran" row that you can expand.
- **Output is capped.** At most 4,000 characters of output are kept, with the start and the end of longer output.
- **Live output is throttled.** A long-running hook's output updates the row at most every 5 seconds, so the session's history doesn't record every chunk.
- **Outside a turn.** A run that happens outside a turn, such as a `SessionStart` hook as the session opens, shows at the start of the next turn.

Claude Code reports command, HTTP and MCP tool hooks; prompt and agent hooks run without a trace. Agent Rishi's own permission hook never shows. The Markdown export lists each run among the tool calls around it. For failed and blocked runs it includes the reason, with secrets hidden like the rest of the export. Hook runs are searchable by event and by what ran. Editing hooks is unchanged.

## What's loaded

For any session, **Details → What's loaded** shows which memory files, skills, subagents, MCP servers and hooks are actually in its context, computed the way each provider does it from the session's working directory:

- **Claude** walks every folder up from the working directory for `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules`, adds the auto-memory `MEMORY.md`, and the project's skills and subagents up to the repo root.
- **Codex** takes `AGENTS.override.md` or `AGENTS.md` in `~/.codex` and in each folder from the repo root down to the working directory.

It's the quickest way to answer "why did the agent do that?" when an old rule is still in play.

### MCP servers in What's loaded

The **MCP servers** list shows the servers configured for the session, Agent Rishi's own (`agent-rishi`, "built in") included. For providers that report their servers' live state (today Claude Code and Codex), each row also shows where that server stands right now: **connected**, **starting**, **failed**, **needs sign-in** or **disabled**. Hover a failed server for the provider's error. Servers the provider runs that aren't in the config files Agent Rishi reads, such as a plugin's servers or Claude connectors, are listed too.

When a server failed or needs sign-in, the agent can't use its tools, so a notice under the session's header names those servers. For a failed server, check its settings on **Agents › MCP servers**, where **Test the connection** tries it. For one that needs sign-in, sign in through the provider's own MCP login for that server; Agent Rishi doesn't sign in for you. Where the provider says where a server comes from (today Claude Code), an account connector (such as a claude.ai connector) or a plugin's server that only needs sign-in is left out of the notice: the provider offers those to every session whether the work needs them or not. They still show in What's loaded, and a failed one is still named.

The notice goes away once the servers connect. Its close button hides it for those servers in every session of the project, and this browser remembers it across reloads; the notice comes back only when another server gets into trouble, or one of them in another way (a server that needed sign-in now fails). Trouble with Agent Rishi's own server (`agent-rishi`) is the exception: without it the agent can't ask you questions or report back, so it shows in each session until you dismiss it there. Only server names, states, where they come from and the provider's short error (first line, with anything that looks like a secret masked) are kept; commands, URLs, headers and environment values never are.

### Hooks in What's loaded

For providers whose native config has hooks (today Claude Code), a **Hooks** list shows every hook that applies to the session's folder. Each row has its event and matcher (`all` when the hook has no matcher, so it runs for everything), what it runs and its scope. Hover a row to see its settings file. **Edit hooks** opens the Hooks tab for the session's project. The files that apply are:

- `~/.claude/settings.json`;
- `.claude/settings.json` in the session's working folder itself. Claude Code doesn't look in parent folders for this file. A worktree session therefore reads the worktree's checked-out copy, not the main checkout's, so commit a hook (or copy it into the worktree) for worktree sessions to run it;
- `.claude/settings.local.json` at the repository root, which for a worktree is the main checkout's root. On Windows, outside a git repository, or when the repository is your home folder, Claude Code reads it next to `.claude/settings.json` in the working folder instead. A local file an older Claude Code left in the working folder is still read, so it is listed too.

`disableAllHooks` switches off the hooks of every file for the whole session, not just the file that sets it. The value from the file with the highest precedence wins (local over project over user). When it is on, the list says which file turned hooks off, dims the hooks, and flags any other file that also sets it. When a file sets it but a higher file sets it to `false`, so hooks still run, the list says that too. A file that can't be parsed, or that a link takes outside its folder, is shown with its error. Hooks you disabled on the Hooks tab don't run, so they aren't listed. Hooks from managed policy settings, plugins, and skill or subagent front matter aren't listed. Neither is Agent Rishi's own permission hook. When the session's provider reports its hook runs, a line under the list says that each run shows in the transcript (see [Hook runs in the transcript](#hook-runs-in-the-transcript)).

## Agent Rishi's own additions

Agent Rishi adds two things to every agent session and never writes them into your files:

- its **MCP server** (`agent-rishi`), with the tools for the session's role, passed to the provider at start-up;
- a short **system-prompt section** explaining those tools (report progress, ask the user, open a PR, attach evidence, suggest follow-ups, finish).
