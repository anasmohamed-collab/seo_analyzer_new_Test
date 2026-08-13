/**
 * A fake `pg` pool that emulates the documented semantics of the SQL in
 * projects.ts, shared by the route tests and the create-only import tests.
 *
 * Two INSERT statements exist and they behave differently on conflict, so the
 * fake dispatches on the conflict clause rather than on "is this an insert":
 *
 *   ON CONFLICT (domain) DO UPDATE …   the legacy upsert — rewrites the row
 *   ON CONFLICT (domain) DO NOTHING    the create-only contract — returns no
 *                                      row and leaves the existing one alone
 *
 * `updated_at` advances on every statement that really writes, so a test can
 * detect a write that the production code was not supposed to perform.
 *
 * The fake can drift from the real SQL, so tests also assert the statement
 * text itself.
 */

export interface SiteRow {
  id: string;
  domain: string;
  project_name: string | null;
  website_url: string | null;
  is_beta: boolean;
  last_form_values: Record<string, string> | null;
  created_at: string;
  updated_at: string;
  last_audit_at: string | null;
}

export interface FakeSitesDb {
  sites: SiteRow[];
  executedSql: string[];
  available: boolean;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  reset(): void;
  /** Insert a row directly, bypassing the API — used to simulate a race. */
  seed(row: Partial<SiteRow> & { domain: string }): SiteRow;
  /** A deep copy of the current rows, for before/after comparison. */
  snapshot(): SiteRow[];
}

export function createFakeSitesDb(): FakeSitesDb {
  const sites: SiteRow[] = [];
  const executedSql: string[] = [];
  let nextId = 1;
  let clock = 0;

  // A strictly increasing timestamp: any real write is visibly different from
  // the value the row had before it.
  const now = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();

  const db: FakeSitesDb = {
    sites,
    executedSql,
    available: true,

    reset() {
      sites.length = 0;
      executedSql.length = 0;
      nextId = 1;
      clock = 0;
      db.available = true;
    },

    seed(row) {
      const created = now();
      const seeded: SiteRow = {
        id: row.id ?? `site-${nextId++}`,
        domain: row.domain,
        project_name: row.project_name ?? null,
        website_url: row.website_url ?? null,
        is_beta: row.is_beta ?? false,
        last_form_values: row.last_form_values ?? null,
        created_at: row.created_at ?? created,
        updated_at: row.updated_at ?? created,
        last_audit_at: row.last_audit_at ?? null,
      };
      sites.push(seeded);
      return seeded;
    },

    snapshot() {
      return JSON.parse(JSON.stringify(sites)) as SiteRow[];
    },

    query(sql: string, params: unknown[] = []) {
      executedSql.push(sql);

      if (/SELECT id, domain FROM sites WHERE domain/i.test(sql)) {
        const row = sites.find((s) => s.domain === String(params[0]));
        return Promise.resolve({ rows: row ? [{ id: row.id, domain: row.domain }] : [] });
      }

      if (/SELECT id, domain FROM sites WHERE id/i.test(sql)) {
        const row = sites.find((s) => s.id === String(params[0]));
        return Promise.resolve({ rows: row ? [{ id: row.id, domain: row.domain }] : [] });
      }

      if (/UPDATE sites[\s\S]*SET last_form_values/i.test(sql)) {
        const [formValues, id] = params as [string, string];
        const row = sites.find((s) => s.id === id);
        if (!row) return Promise.resolve({ rows: [] });
        row.last_form_values = JSON.parse(formValues);
        row.updated_at = now();
        return Promise.resolve({ rows: [{ ...row }] });
      }

      // ── create-only: INSERT … ON CONFLICT (domain) DO NOTHING ────
      if (/INSERT INTO sites/i.test(sql) && /DO NOTHING/i.test(sql)) {
        const [domain, projectName, websiteUrl, isBeta, formValues] = params as [
          string, string, string, boolean | null, string | null,
        ];
        if (sites.some((s) => s.domain === domain)) {
          // No row returned, and — crucially — nothing about the existing row
          // is touched, not even updated_at.
          return Promise.resolve({ rows: [] });
        }
        const stamp = now();
        const row: SiteRow = {
          id: `site-${nextId++}`,
          domain,
          project_name: projectName,
          website_url: websiteUrl,
          is_beta: isBeta ?? false,
          // NULL unless the caller explicitly asked for a configured create.
          last_form_values: formValues == null ? null : JSON.parse(formValues),
          created_at: stamp,
          updated_at: stamp,
          last_audit_at: null,
        };
        sites.push(row);
        return Promise.resolve({ rows: [{ ...row }] });
      }

      // ── legacy upsert: INSERT … ON CONFLICT (domain) DO UPDATE ───
      if (/INSERT INTO sites/i.test(sql)) {
        const [domain, projectName, websiteUrl, formValues, isBeta] = params as [
          string, string, string, string | null, boolean | null,
        ];
        const existing = sites.find((s) => s.domain === domain);

        if (existing) {
          existing.project_name = projectName;
          existing.website_url = websiteUrl;
          // COALESCE(EXCLUDED.last_form_values, sites.last_form_values)
          if (formValues !== null) existing.last_form_values = JSON.parse(formValues);
          // Omission preserves the existing classification.
          if (isBeta !== null) existing.is_beta = isBeta;
          existing.updated_at = now();
          return Promise.resolve({ rows: [{ ...existing, created: false }] });
        }

        const stamp = now();
        const row: SiteRow = {
          id: `site-${nextId++}`,
          domain,
          project_name: projectName,
          website_url: websiteUrl,
          is_beta: isBeta ?? false,
          last_form_values: formValues === null ? null : JSON.parse(formValues),
          created_at: stamp,
          updated_at: stamp,
          last_audit_at: null,
        };
        sites.push(row);
        return Promise.resolve({ rows: [{ ...row, created: true }] });
      }

      if (/^\s*UPDATE sites/i.test(sql)) {
        const [projectName, isBeta, id] = params as [string | null, boolean | null, string];
        const existing = sites.find((s) => s.id === id);
        if (!existing) return Promise.resolve({ rows: [] });
        if (projectName !== null) existing.project_name = projectName;
        if (isBeta !== null) existing.is_beta = isBeta;
        existing.updated_at = now();
        return Promise.resolve({ rows: [{ ...existing }] });
      }

      if (/DELETE FROM sites/i.test(sql)) {
        const index = sites.findIndex((s) => s.id === String(params[0]));
        if (index === -1) return Promise.resolve({ rows: [] });
        const [removed] = sites.splice(index, 1);
        return Promise.resolve({ rows: [removed] });
      }

      if (/FROM sites s/i.test(sql)) {
        return Promise.resolve({
          rows: sites.map((s) => ({ ...s, audit_count: 0, completed_count: 0 })),
        });
      }

      return Promise.resolve({ rows: [] });
    },
  };

  return db;
}
