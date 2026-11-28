import { describe, expect, it } from "vitest";
import { LocalOwner, OwnerId, Ownership, personal } from "../src/ownership";

const id = `own_${"a1".repeat(16)}`;

describe("ownership", () => {
  it("round-trips an ownership through JSON", () => {
    const value = { owner: id, scope: "company" };
    expect(Ownership.parse(JSON.parse(JSON.stringify(Ownership.parse(value))))).toEqual(value);
  });

  it.each([
    ["own_123", "too short"],
    [`OWN_${"a1".repeat(16)}`, "wrong prefix"],
    [`own_${"g1".repeat(16)}`, "not hex"],
    ["", "empty"],
  ])("refuses the owner id %j (%s)", (value, _why) => {
    expect(OwnerId.safeParse(value).success).toBe(false);
  });

  it("refuses an unknown scope or field", () => {
    expect(Ownership.safeParse({ owner: id, scope: "world" }).success).toBe(false);
    expect(Ownership.safeParse({ owner: id, scope: "personal", x: 1 }).success).toBe(false);
  });

  it("makes personal ownership from the local owner or its id", () => {
    const local = LocalOwner.parse({ id, createdAt: "2026-11-28T00:00:00.000Z" });
    expect(personal(local)).toEqual({ owner: id, scope: "personal" });
    expect(personal(id)).toEqual({ owner: id, scope: "personal" });
  });
});
