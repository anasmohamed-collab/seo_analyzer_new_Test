# IT empty-database bootstrap request

The error `relation "public.sites" does not exist` means the supplied connection
does not contain the SEO Analyzer schema. Because the live application already
returns existing projects, first confirm whether this is the intended new
application database or the wrong `DATABASE_URL`.

## Required identity check

Run this without printing the connection string:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"
```

Compare the host, port, database, and user with the `DATABASE_URL` configured on
the Production application. If they differ, stop and use the application's real
database; `PRODUCTION_PROJECT_IMPORT.sql` is the correct file for that existing
database.

## Only for a confirmed new, empty application database

`PRODUCTION_FULL_BOOTSTRAP.sql` contains the complete current application
structure and 45 configured project rows:

- 13 project records reconstructed from the read-only Production inventory;
- 32 reviewed GSC project records;
- `schema_migrations`, `seo_analyses`, `sites`, `seed_urls`, `audit_runs`, and
  `audit_results`, including constraints, indexes, triggers, RLS, and policies.

It is not a historical database dump. Historical audit runs/results and SEO
analysis rows are not available from the API snapshot, so those tables start
empty. Use a real `pg_dump` from the old application database if history must be
preserved.

Run the script as the database owner/application database user. Keep the SEO
runner disabled and notifications off.

Mandatory dry-run:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f PRODUCTION_FULL_BOOTSTRAP.sql
```

Required final line:

```text
SUCCESS: full bootstrap dry run passed and rolled back; database was not changed.
```

Apply only after the dry-run succeeds:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v apply=true \
  -f PRODUCTION_FULL_BOOTSTRAP.sql
```

Required final line:

```text
SUCCESS: full schema and 45 configured projects committed to the empty database.
```

Then configure/reconfirm the application uses this exact `DATABASE_URL`, restart
the application, and verify:

```sql
SELECT
  count(*) AS total_projects,
  count(*) FILTER (
    WHERE last_form_values ? 'homeUrl'
      AND last_form_values ? 'articleUrl'
  ) AS configured_projects,
  (SELECT count(*) FROM public.audit_runs) AS audit_runs
FROM public.sites;
```

Expected: `45` total, `45` configured, `0` audit runs. Also verify the
application's `GET /api/projects` returns 45 projects.

The bootstrap deliberately aborts if any table already exists in `public` and
cannot be replayed. Do not remove this guard, drop existing tables, or use this
file to overwrite an existing database.
