# Backend development

- Git workflow: create a new branch for each task, push that branch and open a pull request targeting `main`. Never commit or push directly to `main`, force-push it, or merge a pull request without the user's instruction.
- Use Node.js >=24.15 and the committed npm lockfile; install with `npm ci`.
- Keep HTTP controllers small. Put database, queue and model work behind their modules/services.
- Validate all environment configuration in `src/config/environment.ts`; default external services are disabled. Never commit `.env`, credentials, book uploads or generated clients.
- All API routes use `/api`. Successful responses are `{ data, meta: { requestId } }`; errors are `{ error: { code, message, details? }, meta: { requestId } }`. Use the global interceptor, filter and DTO validation instead of duplicating response wrappers.
- Keep Swagger response schemas aligned with actual envelopes. Production documentation is disabled by default.
- Logs must not contain headers, request bodies, book text, model prompts, connection URLs, raw upstream errors or secrets. Request IDs and safe event codes identify failures.
- Prisma source is `prisma/schema.prisma`; generated files in `src/generated/` are ignored. Commit schema and reviewed migrations together. Migrations are an explicit operator step, never app startup; do not use automatic schema synchronization.
- BullMQ currently has a producer entry point only. Add explicit payload validation, idempotency and bounded concurrency before adding a worker. Paid model calls have no automatic retry by default.
- Run `npm run check` after changes. Infrastructure integration tests require explicit opt-in and isolated MySQL/Redis on localhost ports 3307/6380; do not point tests at a user's existing database.

## Public typography beta

2026-10-29: User authorized https://epub.199.30.89.47.sslip.io/ on their shared server. See docs/public-beta.md for opt-in access/expiry/resource contract and docs/public-beta-deployment.md for actual systemd/Caddy paths and rollback. Keep public beta deterministic/model-free and preserve loopback/fixedHTTPS/owner isolation. Never reuse historical private illustration data or remove lock/marker files. Do not restart active Worker without handling tasks. Current release is the checked working tree; no Git commit/push/database migration was performed.
