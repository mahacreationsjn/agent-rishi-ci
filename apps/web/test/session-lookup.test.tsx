import type { EventEnvelope, Session } from "@agent-rishi/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { syncSessionQueries } from "@/lib/archived-sessions";
import { useSessionLookup, useSessionLookups } from "@/lib/queries";
import { renderWithClient } from "./utils";

/**
 * The snapshot carries only the recently archived sessions (#323): an older one opened from a
 * link, a search hit or a factory item is fetched by id, and live events keep that copy current.
 */

const ARCHIVED_AT = "2026-10-01T08:00:00.000Z";

function Probe({ id }: { id: string }) {
  const { session, loading } = useSessionLookup(id);
  return <p>{loading ? "loading" : session ? (session.title ?? session.purpose) : "missing"}</p>;
}

async function clientWithout(id: string) {
  const client = createMockClient();
  const snap = await client.getSnapshot();
  const target = snap.sessions.find((s) => s.id === id) as Session;
  vi.spyOn(client, "getSnapshot").mockResolvedValue({
    ...snap,
    sessions: snap.sessions.filter((s) => s.id !== id),
  });
  const archived = { ...target, title: "Old work", archivedAt: ARCHIVED_AT };
  const lookup = vi.spyOn(client, "getSessions").mockResolvedValue([archived]);
  return { client, archived, lookup };
}

describe("looking up a session (#323)", () => {
  it("fetches an archived session the snapshot doesn't carry, and follows live updates", async () => {
    const { client, archived, lookup } = await clientWithout("s-deps");
    const { queryClient } = renderWithClient(<Probe id="s-deps" />, client);

    expect(await screen.findByText("Old work")).toBeTruthy();
    expect(lookup).toHaveBeenCalledWith(["s-deps"]);

    const env = {
      seq: 99_999,
      ts: new Date().toISOString(),
      sessionId: "s-deps",
      type: "session.updated",
      payload: { session: { ...archived, title: "Renamed while archived" } },
    } as EventEnvelope;
    act(() => syncSessionQueries(queryClient, env));
    expect(await screen.findByText("Renamed while archived")).toBeTruthy();
  });

  it("reads a session the snapshot carries without fetching it", async () => {
    const client = createMockClient();
    const lookup = vi.spyOn(client, "getSessions");
    const snap = await client.getSnapshot();
    const session = snap.sessions.find((s) => s.id === "s-deps") as Session;
    renderWithClient(<Probe id="s-deps" />, client);

    expect(await screen.findByText(session.title ?? session.purpose)).toBeTruthy();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("says a session the server doesn't have is missing", async () => {
    const { client } = await clientWithout("s-deps");
    vi.spyOn(client, "getSessions").mockResolvedValue([]);
    renderWithClient(<Probe id="s-deps" />, client);

    expect(await screen.findByText("missing")).toBeTruthy();
  });
});

/** What each render's `useSessionLookups` returned, to check it stays the same map. */
const seen: ReadonlyMap<string, Session>[] = [];

function Several({ ids }: { ids: string[] }) {
  const [renders, setRenders] = useState(0);
  // A new array every render, with the same ids.
  const found = useSessionLookups([...ids]);
  seen.push(found);
  return (
    <>
      {ids.map((id) => (
        <Probe key={id} id={id} />
      ))}
      <p data-testid="several">{[...found.keys()].sort().join(",")}</p>
      <button type="button" onClick={() => setRenders(renders + 1)}>
        Render again
      </button>
    </>
  );
}

describe("looking up several sessions (#372)", () => {
  it("fetches the sessions a render needs in one request, and only once", async () => {
    const client = createMockClient();
    const snap = await client.getSnapshot();
    const gone = ["s-deps", "s-a11y", "s-checkout"];
    vi.spyOn(client, "getSnapshot").mockResolvedValue({
      ...snap,
      sessions: snap.sessions.filter((s) => !gone.includes(s.id)),
    });
    const lookup = vi.spyOn(client, "getSessions");
    renderWithClient(<Several ids={[...gone, "s-search"]} />, client);

    await waitFor(() =>
      expect(screen.getByTestId("several").textContent).toBe("s-a11y,s-checkout,s-deps,s-search"),
    );
    // One request for the three the snapshot lacks, whichever hook asked; none for s-search.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect([...(lookup.mock.calls[0]?.[0] ?? [])].sort()).toEqual(gone.slice().sort());

    // Rendering again asks for nothing, and gives the same map.
    const before = seen.length;
    fireEvent.click(screen.getByRole("button", { name: "Render again" }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(before));
    expect(seen.at(-1)).toBe(seen[before - 1]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
