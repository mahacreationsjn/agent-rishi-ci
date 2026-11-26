import { createContext, type ReactNode, useContext } from "react";
import { useConnectionStore } from "@/stores/connection";
import type { AgentRishiClient } from "./client";
import { createHttpClient } from "./http-client";
import { createMockClient } from "./mock";

export type { AgentRishiClient, InboxResolution, SendMode } from "./client";
export { ApiRequestError } from "./http";

/**
 * Mock mode only when `VITE_AGENT_RISHI_MOCK=1` is set explicitly (UI work without a server).
 * Everything else, and every production build, talks to the real server.
 */
export const isMockMode: boolean =
  import.meta.env.VITE_AGENT_RISHI_MOCK === "1" && import.meta.env.DEV;

/** Base URL of the Agent Rishi server (same origin by default; configurable for a desktop shell). */
export const serverOrigin: string =
  import.meta.env.VITE_AGENT_RISHI_SERVER ?? window.location.origin;

export function createClient(): AgentRishiClient {
  if (isMockMode) return createMockClient({ ambient: true });
  return createHttpClient(serverOrigin, {
    onUnauthorized: (code) =>
      useConnectionStore
        .getState()
        .setAuth(code === "sign_in_required" ? "signin" : "unauthorized"),
  });
}

const ClientContext = createContext<AgentRishiClient | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  client: AgentRishiClient;
  children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** The active API client. */
export function useClient(): AgentRishiClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient must be used inside <ClientProvider>");
  return client;
}
