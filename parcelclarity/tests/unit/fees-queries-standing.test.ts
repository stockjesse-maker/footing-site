import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { listFeeSchedules } = await import("@/lib/fees/queries");

/**
 * Which version a schedule's status line calls "in effect". The database resolves a day to an active or an
 * archived version whose dates cover it (app.fee_version_on), so archiving a version must not make the list
 * or the customer page say that nothing is in effect; only an ended or not-yet-started version does.
 */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

type V = { id: string; version_number: number; status: string; effective_date: string | null; expiration_date: string | null };
const rowsFor = (versions: V[]) => ({
  data: [{ id: "s1", name: "Standard", description: null, status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", fee_schedule_versions: versions, brand_fee_schedule_assignments: [] }],
  error: null,
});
const fakeClient = (versions: V[]) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ overrideTypes: async () => rowsFor(versions) }) }) }) }) }) as never;
const one = async (versions: V[]) => (await listFeeSchedules(fakeClient(versions), "t"))[0]!;
const v = (n: number, status: string, from: number | null, to: number | null): V => ({ id: `v${n}`, version_number: n, status, effective_date: from === null ? null : day(from), expiration_date: to === null ? null : day(to) });

describe("a fee schedule's version in effect today", () => {
  it("is an active version whose dates cover today", async () => {
    const s = await one([v(1, "active", -30, null)]);
    expect(s.inEffectVersion).toMatchObject({ versionNumber: 1, status: "active" });
    expect(s.activeVersion?.versionNumber).toBe(1);
  });

  it("is still the version after it is archived, because archiving does not stop it applying inside its dates", async () => {
    const s = await one([v(1, "archived", -30, null)]);
    expect(s.activeVersion).toBeNull(); // nothing can be assigned from it...
    expect(s.inEffectVersion).toMatchObject({ versionNumber: 1, status: "archived" }); // ...but pricing still uses it
  });

  it("prefers an active version over an archived one that covers the same day", async () => {
    const s = await one([v(1, "archived", -60, null), v(2, "active", -30, null)]);
    expect(s.inEffectVersion).toMatchObject({ versionNumber: 2, status: "active" });
  });

  it("is nothing when the version has ended or has not started, and the active version still reads as scheduled or ended", async () => {
    const ended = await one([v(1, "active", -60, -10)]);
    expect(ended.inEffectVersion).toBeNull();
    expect(ended.activeVersion?.versionNumber).toBe(1);
    const future = await one([v(1, "active", 10, null)]);
    expect(future.inEffectVersion).toBeNull();
    expect(future.activeVersion?.versionNumber).toBe(1);
  });

  it("ignores drafts and discarded versions, which carry no dates that price anything", async () => {
    const s = await one([v(1, "draft", null, null), v(2, "discarded", null, null)]);
    expect(s.inEffectVersion).toBeNull();
    expect(s.activeVersion).toBeNull();
  });
});
