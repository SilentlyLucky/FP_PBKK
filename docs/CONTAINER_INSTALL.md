# PromptLab local Docker installation

This is the product Compose path. It runs the web app, one worker, a one-shot
database migration, PostgreSQL, and Redis in Docker. The web port is bound to
loopback. The developer path remains `corepack pnpm dev:stack` and explicitly
uses `docker-compose.yml`.

## Prerequisites

- A Linux host with Docker Engine, or Windows with Docker Desktop configured
  for Linux containers and WSL 2 integration.
- Docker Compose CLI **v2.2.0 or later** because the install command uses
  `--wait` ([present in the v2.2.0 CLI source](https://github.com/docker/compose/blob/v2.2.0/cmd/compose/up.go)).
- Bash on Linux or WSL. The commands below are not written for PowerShell.
- Network access while Docker downloads the base images, package dependencies,
  and pinned Codex CLI during the first build. This is installation traffic;
  it does not run model inference.

The product Compose path does not require Node.js, Python, pnpm, or RTK on the
host. Docker Desktop must be allowed to access the checkout directory. This
stack is intended for one local user and must not be published to a public
network. The checks recorded below ran from Bash in Ubuntu 22.04 under WSL 2
with Docker Desktop's Linux engine. A native Linux Docker Engine was not
separately acceptance-tested.

Codex runs inside the existing bubblewrap isolation profile. Docker's default
seccomp profile blocks the namespace setup bubblewrap needs. The web and worker
services therefore use `seccomp=unconfined` and drop **all Linux capabilities**;
they do not receive `SYS_ADMIN`. The database, Redis, and migration services
keep Docker's default security profile. The stack does not use privileged
containers or disable Codex's bubblewrap isolation. The pinned CLI preflight
and filesystem canaries passed with this profile.

## First start

Run these commands from the repository root:

```sh
cp .env.container.example .env.container
chmod 600 .env.container
openssl rand -hex 32
```

Copy the generated 64-character hex value into
`PROMPTLAB_POSTGRES_PASSWORD` in `.env.container`. Enter the Campus API key and
the exact model ID supplied for your own gateway account when ready; they may
remain blank during initial setup. Keep `.env.container` private and out of
source control.

Start the product stack and wait for its health checks:

```sh
docker compose --env-file .env.container -f compose.yaml up -d --build --wait
```

Open <http://127.0.0.1:3000>. Change `PROMPTLAB_WEB_PORT` in the local config
if that host port is already in use. PostgreSQL and Redis are only reachable
inside the Compose network and do not publish host ports.

## Provider setup

Set `PROMPTLAB_CAMPUS_API_KEY` and `PROMPTLAB_CAMPUS_MODEL` in
`.env.container`, then apply the changed configuration with the start command
below. Provider status is available in **Settings**. The service health checks
do not probe a provider, so an unavailable or unconfigured provider leaves the
UI available for setup. A production run still requires both the mandatory
optimizer and its selected Codex target to be ready; the app reports a blocked
run when either is unavailable.

Use **Login Codex** in Settings to start the official device login and complete
it yourself in the browser. This image starts with an empty, per-instance auth
home. It does not import or copy the developer's Codex files. The supported
Codex account requirements are enforced by the existing provider flow; an API
key is not a substitute for the supported ChatGPT login.

## Optional read-only source folder

Uploaded PDF, Markdown, and text sources use the existing knowledge intake.
The intake stores extracted knowledge in PostgreSQL; it does not currently
preserve the original uploaded bytes as a managed-file backup. Keep original
files in your own storage.

To expose a selected host folder read-only to the web and worker containers:

1. Set `PROMPTLAB_COLLECTIONS_PATH` in `.env.container` to the host directory
   you selected.
2. Set `PROMPTLAB_LOCAL_WORKSPACE_ROOTS` to a JSON array mapping an existing
   project UUID to a container path under `/collections`. For example:
   `[ {"projectId":"<existing-project-uuid>","rootPath":"/collections"} ]`.
   Replace the placeholder with the actual project UUID. A narrower path such
   as `/collections/docs` can limit access further.
3. Start the stack with the optional source override:

   ```sh
   docker compose --env-file .env.container -f compose.yaml -f compose.sources.yaml up -d --build --wait
   ```

With this Docker override, the directory picker starts at `/collections` and
its navigation is confined to the host folder explicitly mounted there through
`PROMPTLAB_COLLECTIONS_PATH`. The picker cannot browse other host folders.

The app still requires an explicit project-scoped read grant before reading
files. The bind mount is read-only; it does not copy files into PromptLab. A
WSL filesystem path was verified: both web and worker could read a fixture, and
writes failed with `EROFS`. Windows host paths were not separately tested; use
a path in the WSL filesystem for the validated setup.

## Optional dedicated writable workspace

This feature is optional. The tracked `compose.workspace.example.yaml` is a
generic template; copy it to `compose.workspace.yaml`, which is a local,
git-ignored configuration. Set `PROMPTLAB_WORKSPACE_PATH` to a dedicated host
directory, `PROMPTLAB_WORKSPACE_PROJECT_ID` to an existing project UUID, and
`PROMPTLAB_WORKSPACE_GROUP_ID` to a host group that can access that directory
in `.env.container`. Create the directory and copy the template:

```sh
mkdir -p /absolute/path/to/dedicated/workspace
chmod 2770 /absolute/path/to/dedicated/workspace
cp compose.workspace.example.yaml compose.workspace.yaml
```

Place a project checkout or copy there before using **Tinjau file, usulkan,
dan jalankan tes**. Start the stack with the override:

```sh
docker compose --env-file .env.container -f compose.yaml -f compose.workspace.yaml up -d --build --wait
```

The UI can request a short-lived write grant and apply only a patch you
explicitly approve. This does not enable general shell access or automatic
Codex edits. The mount is writable by the web container, so keep only files
you intend to edit in this dedicated folder. Reuse the override when
recreating the web container.

## Readiness and status

- `GET /api/health` is web process liveness.
- `GET /api/health/ready` checks database connectivity, the migrated project
  schema, and Redis. It does not check Campus, Codex account login, or a
  project's selected knowledge sources.
- The worker's `/health/live` and `/health/ready` endpoints are internal to the
  Compose network. Worker readiness also requires its BullMQ consumer to be
  running.
- Provider status is reported by the existing provider Settings API; selected
  project knowledge status is reported by the existing project readiness API.

## Stop, restart, update, and data

Run these from the repository root with `.env.container` present:

```sh
docker compose --env-file .env.container -f compose.yaml stop
docker compose --env-file .env.container -f compose.yaml up -d --wait
docker compose --env-file .env.container -f compose.yaml down
```

`down` removes the containers and network but keeps the named PostgreSQL,
Redis, app-data, and Codex-auth volumes. The auth volume is mounted only at
PromptLab's dedicated auth home and is owner-only inside the container. The
app-data volume is reserved for managed application files; original upload
blob persistence is not connected yet. Removing named volumes deletes local
data, so do not add `-v` unless you deliberately intend to erase it.

For a source checkout update, update the checkout and rebuild with:

```sh
docker compose --env-file .env.container -f compose.yaml up -d --build --wait
```

The one-shot migration completes before either app service starts. Back up
important local data before changing versions or schema. For a database dump:

```sh
docker compose --env-file .env.container -f compose.yaml exec -T postgres pg_dump -U promptlab promptlab > promptlab-backup.sql
```

## Verified behavior and remaining gates

The October 19, 2026 offline container checks used isolated
`promptlab-flow0-*` projects and named volumes. They did not alter the existing
Flow 1 or local development stacks.

- The `migrate`, `web`, and `worker` images built successfully. The successful
  migration exited `0`; web and worker became healthy, and
  `GET /api/health/ready` returned HTTP `200`.
- An isolated migration override exited `23`. Compose returned failure, and
  web and worker remained in `Created` state without starting.
- Codex CLI `0.160.1` passed the actual bubblewrap `--version` preflight with
  `cap_drop: ALL`, `seccomp=unconfined`, and networking disabled for the test
  container. The `/workspace` and host-home canaries were inaccessible
  (`ENOENT`); the private scratch directory was writable.
- The running stack reported the dedicated Codex home as not logged in. No
  OAuth login or provider inference was attempted.
- Synthetic markers in the named `app-data` and `codex-auth` volumes survived
  a web/worker restart, then were removed. This proves volume persistence; it
  does not prove that a real Codex login survives a restart.
- The read-only WSL source mount was visible to web and worker, and both
  received `EROFS` when they attempted to write to it.

Original upload byte retention and provider-backed prompt execution remain
separate acceptance gates. Graphify extraction and pgvector/semantic retrieval
belong to Flow 1.
