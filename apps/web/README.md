# @agent-rishi/web

The Agent Rishi web UI: a React 19 + Vite single-page app that the Agent Rishi server serves. Commands are in the repository's `AGENTS.md` (`pnpm dev`, `pnpm build`, `pnpm test`).

## Keeping the first load small

Phones and tablets open Agent Rishi over plain http on the LAN or a VPN, where no service worker caches the app. Every first load downloads and parses whatever the entry chunk (and the chunks `index.html` preloads) holds before Home, the inbox or a session can render. Keep heavy code out of it:

- **Pages load on demand.** Every page in `src/router.tsx` is a `lazyRouteComponent`. The router fetches a page's chunk before it shows the route, and when a link to it is hovered or focused, so pages don't flash a loading state. Add new pages the same way, and keep `validateSearch` helpers in a small module of their own (like `src/routes/agent-tabs.ts`) so the router doesn't import the page.
- **Heavy panels load on demand.** Libraries only some panels need are imported through `src/components/on-demand.tsx`: the terminal (`@xterm/*`), the diff viewer (`@pierre/diffs`), the code editor (`@codemirror/*`) and the Factory view's Floor mode (`three`). Charts (`recharts`) are used only by their own pages. To add one, export a `lazyComponent` there with a fallback sized like the component, and import that instead of the module.
- **Never import a heavy module statically** from the shell, the router or anything else the entry reaches, not even through a helper module that also imports it. `import type` is fine: it is erased at build time.
- **The test guards it.** `test/entry-chunk.test.ts` walks the static imports from `src/main.tsx` and fails, showing the import chain, when one of these libraries becomes reachable from the entry again. Add a new heavy library to its list.
- **Updates.** A tab that was open across an update still asks for the old chunk names. For a page the app reloads once; for a panel it shows a reload prompt (`ChunkErrorBoundary` in `src/components/common/lazy-component.tsx`).

`pnpm --filter @agent-rishi/web build` prints every chunk's size; `index-*.js` is the entry.
