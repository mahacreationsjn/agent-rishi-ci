import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  isPublicAddress,
  PrivateAddressError,
  publicFetch,
  publicLookup,
} from "../src/network/public-fetch";

describe("public addresses", () => {
  it("accepts the public internet and refuses this computer, private networks and special ranges", () => {
    for (const address of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:50c0:8000::154"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "10.1.2.3",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.251",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:192.168.0.1",
      "not an address",
      "",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("publicLookup", () => {
  const lookupWith = (addresses: LookupAddress[]) =>
    publicLookup((_host, _options, callback) => callback(null, addresses));
  const run = (lookup: ReturnType<typeof publicLookup>, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) =>
      lookup("files.example", { all }, (error, address, family) =>
        resolve({ error, address, family }),
      ),
    );

  it("passes public answers through, as a list or as the first address", async () => {
    const lookup = lookupWith([
      { address: "140.82.112.3", family: 4 },
      { address: "2606:50c0:8000::154", family: 6 },
    ]);
    expect((await run(lookup, true)).address).toHaveLength(2);
    expect(await run(lookup, false)).toEqual({
      error: null,
      address: "140.82.112.3",
      family: 4,
    });
  });

  it("refuses a name when any of its addresses is private (a rebinding answer included)", async () => {
    const lookup = lookupWith([
      { address: "140.82.112.3", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const { error } = await run(lookup, false);
    expect(error).toBeInstanceOf(PrivateAddressError);
    expect(error?.message).toBe("files.example is on this computer or a private network");
  });

  it("passes resolver errors on", async () => {
    const failure = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const lookup = publicLookup((_host, _options, callback) => callback(failure, []));
    expect((await run(lookup, true)).error).toBe(failure);
  });
});

describe("publicFetch", () => {
  it("refuses this computer by address or by name before connecting, and anything but https", async () => {
    for (const url of [
      "https://127.0.0.1:9/a.md",
      "https://[::1]:9/a.md",
      "https://localhost:9/a.md",
    ]) {
      await expect(publicFetch(url), url).rejects.toBeInstanceOf(PrivateAddressError);
    }
    await expect(publicFetch("http://example.com/a.md")).rejects.toThrow(/Only https/);
  });
});
