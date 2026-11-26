---
section: fixed
---

- **Codex sessions on Auto or Full no longer get stuck read-only.** Every Codex turn now carries the session's sandbox and approval policy, not only the turn after a permissions change. Codex keeps the sandbox of a thread it still has loaded when Agent Rishi resumes it, so a builder could show Full yet run in a read-only worktree until its permissions were changed. When Codex reports a different sandbox than the one asked for, the transcript shows a warning.
