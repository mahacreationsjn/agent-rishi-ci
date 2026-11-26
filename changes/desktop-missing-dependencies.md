---
section: fixed
---

- **The desktop app includes every runtime dependency again.** playwright-core was missing from the 0.7.10 installer, so the runner failed to start. The build now copies any runtime dependency the packed app lacks and fails if one is still missing.
