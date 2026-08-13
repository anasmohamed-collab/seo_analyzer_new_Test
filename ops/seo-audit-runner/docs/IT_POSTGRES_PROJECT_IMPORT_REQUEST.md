# IT PostgreSQL project import request

Use this only as a controlled alternative to the application import. **Do not
replace or restore the whole Production database.** The supplied SQL inserts
the reviewed missing projects and does not update or delete existing rows.

## Copy/paste request to IT

Please import the 32 reviewed SEO Analyzer projects using
`PRODUCTION_PROJECT_IMPORT.sql` from the approved Git commit/PR.

Before running it:

1. Disable and stop `seo-runner-tick.timer`, confirm
   `seo-runner-tick.service` is inactive, and keep
   `NOTIFICATIONS_ENABLED=false`.
2. Take a timestamped PostgreSQL custom-format backup with `pg_dump` and retain
   it until the import is verified.
3. Use the Production PostgreSQL connection directly with `psql`; do not expose
   the connection string or credentials in the output.

First run the mandatory transactional dry-run:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f PRODUCTION_PROJECT_IMPORT.sql
```

It must end with:

```text
SUCCESS: dry run passed and rolled back; Production was not changed.
```

Only after that succeeds, apply the same file explicitly:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v apply=true \
  -f PRODUCTION_PROJECT_IMPORT.sql
```

It must end with:

```text
SUCCESS: committed exactly 32 new projects; existing projects were unchanged.
```

Please send back the two final success lines and this verification result:

```sql
SELECT
  count(*) AS total_projects,
  count(*) FILTER (
    WHERE last_form_values ? 'homeUrl'
      AND last_form_values ? 'articleUrl'
  ) AS configured_projects
FROM public.sites;
```

The expected total after this reviewed snapshot is **45 projects**. Keep the
runner timer disabled after the import; enabling it is a separate operation.

## Safety properties of the SQL

- The default execution always ends in `ROLLBACK`; `-v apply=true` is required
  for a commit.
- It takes transaction-scoped advisory and table locks and refuses concurrent
  project/audit writes.
- It requires the exact reviewed 13-domain starting inventory and aborts if the
  database has changed.
- It refuses to continue if any incoming domain exists or an audit is running.
- It contains no `UPDATE` or `DELETE` statement.
- It verifies all 32 inserts, preserves every pre-existing row byte-for-byte,
  and confirms no audit was created before commit.
- It stores only `homeUrl` and `articleUrl`, matching the reviewed application
  create-only contract. Optional section URLs are intentionally excluded from
  this database-level import.

Any error is a hard stop. Do not edit out a guard, switch to an upsert, or retry
against a changed inventory; regenerate the import from a fresh snapshot.
