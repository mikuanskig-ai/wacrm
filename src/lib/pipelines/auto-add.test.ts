import { describe, it, expect } from "vitest";
import { autoAddContactsToPipelines, backfillContactsToStage } from "./auto-add";

// Minimal fake chain covering exactly the calls this module makes:
// accounts.select().eq().maybeSingle(), pipelines.select().eq().eq().not(),
// deals.select().eq().in() (existing-deal check), and deals.insert().
function makeDb(seed: {
  accounts?: Record<string, unknown>[];
  pipelines?: Record<string, unknown>[];
  deals?: Record<string, unknown>[];
}) {
  const tables = {
    accounts: seed.accounts ?? [],
    pipelines: seed.pipelines ?? [],
    deals: seed.deals ?? [],
  };
  const insertedRows: Record<string, unknown>[] = [];

  function chain(scope: Record<string, unknown>[]) {
    let filtered = scope;
    const c = {
      select: () => c,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return c;
      },
      not: (col: string) => {
        filtered = filtered.filter((r) => r[col] != null);
        return c;
      },
      in: (col: string, vals: unknown[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return c;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      insert: (rows: Record<string, unknown>[]) => {
        insertedRows.push(...rows);
        tables.deals.push(...rows);
        return Promise.resolve({ error: null });
      },
      then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: filtered, error: null }),
    };
    return c;
  }

  const db = {
    from: (table: keyof typeof tables) => chain(tables[table]),
  };
  return { db, insertedRows };
}

describe("auto-add — deal currency", () => {
  it("stamps new deals with the account's configured default_currency, not the DB's static USD default", async () => {
    const { db, insertedRows } = makeDb({
      accounts: [{ id: "acct-1", default_currency: "BRL" }],
      pipelines: [{ id: "pipe-1", account_id: "acct-1", auto_add_contacts: true, auto_add_stage_id: "stage-1" }],
      deals: [],
    });

    await autoAddContactsToPipelines(db, "acct-1", "user-1", [
      { id: "contact-1", name: "Ana", phone: "5511999999999" },
    ]);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ contact_id: "contact-1", currency: "BRL" });
  });

  it("falls back to USD when the account has no default_currency set", async () => {
    const { db, insertedRows } = makeDb({
      accounts: [{ id: "acct-1", default_currency: null }],
      pipelines: [{ id: "pipe-1", account_id: "acct-1", auto_add_contacts: true, auto_add_stage_id: "stage-1" }],
      deals: [],
    });

    await autoAddContactsToPipelines(db, "acct-1", "user-1", [
      { id: "contact-1", name: "Ana", phone: "5511999999999" },
    ]);

    expect(insertedRows[0]).toMatchObject({ currency: "USD" });
  });

  it("backfillContactsToStage also stamps the account's default_currency", async () => {
    const { db, insertedRows } = makeDb({
      accounts: [{ id: "acct-1", default_currency: "BRL" }],
      deals: [],
    });

    const count = await backfillContactsToStage(db, "acct-1", "user-1", "pipe-1", "stage-1", [
      { id: "contact-1", name: "Ana", phone: "5511999999999" },
    ]);

    expect(count).toBe(1);
    expect(insertedRows[0]).toMatchObject({ currency: "BRL" });
  });

  it("skips a contact that already has a deal in that pipeline (dedup still works)", async () => {
    const { db, insertedRows } = makeDb({
      accounts: [{ id: "acct-1", default_currency: "BRL" }],
      deals: [{ contact_id: "contact-1", pipeline_id: "pipe-1" }],
    });

    const count = await backfillContactsToStage(db, "acct-1", "user-1", "pipe-1", "stage-1", [
      { id: "contact-1", name: "Ana", phone: "5511999999999" },
    ]);

    expect(count).toBe(0);
    expect(insertedRows).toHaveLength(0);
  });
});
