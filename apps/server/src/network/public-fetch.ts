import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import type { OutgoingHttpHeaders } from "node:http";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/**
 * Downloads the user starts from a link (importing automations, §10) reach only the public
 * internet: never this computer, the LAN, link-local addresses (cloud metadata) or other
 * special-purpose ranges.
 */

/** Ranges that are not the public internet (IPv4-mapped IPv6 addresses match their IPv4 range). */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT, Tailscale
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed any IPv4 address)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Is this IP address on the public internet? Anything else, or not an address, is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  try {
    return !NOT_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

/** A link that leads to this computer or a private network. */
export class PrivateAddressError extends Error {
  constructor(readonly host: string) {
    super(`${host} is on this computer or a private network`);
    this.name = "PrivateAddressError";
  }
}

/** Was this failure (or its cause) a refused private address? */
export function isPrivateAddressError(error: unknown): boolean {
  return (
    error instanceof PrivateAddressError ||
    (error instanceof Error && error.cause instanceof PrivateAddressError)
  );
}

type Resolve = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for sockets that refuses a name when any of its addresses is not public. It runs
 * on the connection itself, so a DNS answer that changes after a check can't slip past.
 */
export function publicLookup(
  resolve: Resolve = (hostname, options, callback) => dnsLookup(hostname, options, callback),
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "");
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
        return callback(new PrivateAddressError(hostname), "");
      }
      if (options.all) return callback(null, addresses);
      const [first] = addresses as [LookupAddress];
      callback(null, first.address, first.family);
    });
  };
}

const NULL_BODY = new Set([204, 205, 304]);

/**
 * A minimal `fetch` (GET over https) whose connections go through `publicLookup`, and which
 * refuses address literals that aren't public. Redirects are returned, never followed.
 */
export const publicFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") {
      reject(new TypeError(`Only https downloads are allowed, not ${url.protocol}`));
      return;
    }
    // Address literals connect without a lookup, so they are checked here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicAddress(host)) {
      reject(new PrivateAddressError(url.hostname));
      return;
    }
    const headers: OutgoingHttpHeaders = Object.fromEntries(new Headers(init.headers));
    const req = request(
      url,
      {
        method: "GET",
        headers,
        agent: false,
        lookup: publicLookup(),
        signal: init.signal ?? undefined,
      },
      (res) => {
        try {
          const status = res.statusCode ?? 0;
          const answer = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const v of Array.isArray(value) ? value : [value]) {
              if (v !== undefined) answer.append(name, String(v));
            }
          }
          if (NULL_BODY.has(status)) res.resume();
          const body = NULL_BODY.has(status)
            ? null
            : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, statusText: res.statusMessage, headers: answer }));
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
