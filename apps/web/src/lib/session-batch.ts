import { SESSION_LOOKUP_MAX, type Session } from "@agent-rishi/contracts";
import type { AgentRishiClient } from "./api";

/** Looks one session up by id: the session, or null when the server has none by that id. */
export type SessionLoader = (sessionId: string) => Promise<Session | null>;

interface Waiter {
  resolve: (session: Session | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Looks sessions up by id for the views whose sessions the snapshot no longer carries (§6). The
 * ids asked for in one go (a render's lookups start together) reach the server in one request,
 * `SESSION_LOOKUP_MAX` ids at a time, so a list of cards doesn't make a request per card.
 */
export function createSessionLoader(client: Pick<AgentRishiClient, "getSessions">): SessionLoader {
  let pending = new Map<string, Waiter[]>();

  const flush = () => {
    const batch = pending;
    pending = new Map();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += SESSION_LOOKUP_MAX) {
      const chunk = ids.slice(i, i + SESSION_LOOKUP_MAX);
      const settle = (each: (w: Waiter, id: string) => void) => {
        for (const id of chunk) for (const w of batch.get(id) ?? []) each(w, id);
      };
      // Through a promise, so a client that throws still settles every waiter.
      Promise.resolve()
        .then(() => client.getSessions(chunk))
        .then(
          (found) => {
            const byId = new Map(found.map((s) => [s.id, s]));
            settle((w, id) => w.resolve(byId.get(id) ?? null));
          },
          (error: unknown) => settle((w) => w.reject(error)),
        );
    }
  };

  return (sessionId) =>
    new Promise<Session | null>((resolve, reject) => {
      if (pending.size === 0) queueMicrotask(flush);
      const waiters = pending.get(sessionId) ?? [];
      waiters.push({ resolve, reject });
      pending.set(sessionId, waiters);
    });
}

const loaders = new WeakMap<AgentRishiClient, SessionLoader>();

/** The client's one session loader, shared by every lookup so they batch together. */
export function sessionLoader(client: AgentRishiClient): SessionLoader {
  let loader = loaders.get(client);
  if (!loader) {
    loader = createSessionLoader(client);
    loaders.set(client, loader);
  }
  return loader;
}
