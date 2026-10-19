# Database package

The Drizzle schema is the source for the project migration. `drizzle/rollback/` holds the reviewed reverse SQL; the migration runner never executes rollback files.

Before migrating, point `PROMPTLAB_DATABASE_URL` at the project-local PostgreSQL service from `docker-compose.yml`. The default Compose database is bound to loopback and uses a separate named volume. Do not aim this command at a personal or shared database.

```sh
pnpm db:generate
pnpm db:migrate
```

Graph tables retain project scope on every record. Composite foreign keys prevent an assertion, source chunk, evidence row, or active snapshot from linking to another project's records. Snapshot activation is represented by one project-scoped pointer; application code must replace it in a transaction after validating the source manifest. This schema is a foundation, not a completed graph builder or retrieval implementation.
