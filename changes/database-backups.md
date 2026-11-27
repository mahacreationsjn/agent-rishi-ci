---
section: added
---

- **Database backups and restore.** Agent Rishi keeps the newest seven verified backups of its database: one before a new version first starts, one a day while it runs, and one whenever you run `agent-rishi backup`. After an unexpected stop it checks the database before starting, and if it is damaged it changes nothing and names the backup to restore with `agent-rishi restore <name>`. `agent-rishi restore` lists them, and `agent-rishi doctor` shows how recent the newest is.
