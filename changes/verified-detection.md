---
section: changed
---

- **Setup shows a provider as ready only once it is verified.** The setup checklist now shows the same detection the runner uses, so the two can no longer disagree. A provider is ready only after it has answered a real check with your login (a model list, which uses no tokens), and the row says when that check passed. A provider whose login was found but not checked yet shows "Signed in, not verified yet". Gemini CLI now lists your account's models before the first session, and Antigravity CLI's login in the Linux keyring is now recognised.
