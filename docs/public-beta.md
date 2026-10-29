# Single-server typography beta

This opt-in profile serves anonymous, private EPUB typography for an initial small public trial. It is not a formal account system or the MySQL/BullMQ production design. Node 24.15+, Linux local disk, one API process, one Worker process and a same-host HTTPS reverse proxy are required. SQLite OS locks fence concurrent metadata writes and enforce one Worker; never use network volumes, remove lock files, or reuse the old private illustration data directory.

Required operator configuration (same values for API and Worker):

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3100
SWAGGER_ENABLED=false
PROCESSING_ENABLED=true
PROCESSING_PUBLIC_BETA_ENABLED=true
PROCESSING_REPOSITORY=local
PROCESSING_DATA_DIR=/var/lib/epub-ai-beta
PROCESSING_ALLOWED_ORIGIN=https://your-host.example
PROCESSING_UPLOAD_MAX_MIB=20
PROCESSING_OWNER_ACTIVE_LIMIT=1
PROCESSING_MAX_RUNS=100
PROCESSING_BETA_OWNER_BOOK_LIMIT=5
PROCESSING_BETA_MAX_ACTIVE_RUNS=10
PROCESSING_BETA_STORAGE_MAX_MIB=1024
PROCESSING_BETA_RETENTION_HOURS=24
PROCESSING_AI_ENABLED=false
QWEN_ENABLED=false
IMAGE_GENERATION_ENABLED=false
VISUAL_REVIEW_ENABLED=false
DATABASE_ENABLED=false
REDIS_ENABLED=false
QUEUE_ENABLED=false
THROTTLE_LIMIT=1200
EPUBCHECK_JAVA_PATH=/usr/bin/java
EPUBCHECK_JAR_PATH=/opt/epubcheck/epubcheck.jar
```

The proxy must preserve the exact configured public Host and send `X-Forwarded-Proto: https`. The API accepts only a loopback TCP peer, never trusts arbitrary forwarded client IPs, and requires the exact public Origin on all writes. Cookie `__Host-epub_beta_session` is a random 256-bit private ownership capability, Secure/HttpOnly/SameSite=Strict/Path=/, without a Domain attribute. Deleting browser cookies or using another browser loses access; there is no recovery/login workflow. Owner identities are SHA256 hashes, never URL parameters. Requests and all downloads are no-store; cross-owner IDs return not-found.

Only upload, deterministic `reader-editorial` exports, Run read/cancel, private artifacts and non-secret capabilities are enabled. Legacy themes and illustration/catalog endpoints are denied by the guard, and the Worker independently refuses non-editorial or AI stages. Configuration refuses enabled model providers or public API listening. No model credentials are required or copied. HTTPS health probes never invoke models.

The beta admits at most 20 MiB per source, five currently retained books per owner, one active Run per owner and ten globally active Runs. The global source reservation is at most one quarter of the 1 GiB storage budget; physical disk admission before uploads/new Runs/processing reserves room for two in-flight uploads and one bounded Worker. Idempotent recovery of an existing Run does not consume another reservation. The filesystem walk rejects symlinks/excessive file counts and a nearly exhausted volume is rejected before upload. These are conservative admission bounds, not a filesystem hard quota. Monitor disk space and configure service CPU/memory/time limits. Engine input is additionally bounded to 64 MiB expanded, 16 MiB per entry, 2 MiB XML and 2,000 entries. Editorial CSS matching additionally protects documents over 5,000 elements, 16 stylesheets, 256 KiB total CSS or two million estimated matching work units; complex publishing styles remain unchanged with `EDITORIAL_COMPLEXITY_LIMIT` in the report. EPUBCheck uses a bounded Java child process and timeout.

Uploaded book age starts at successful upload. At 24 hours read/export authorization expires immediately. Every 30 seconds API and Worker prune expired book/Run/artifact metadata atomically, fencing any active publication before deleting the corresponding fixed `sources/UUID.epub` and `runs/UUID` paths. Late or crash-remnant unregistered files are swept after a five-minute safety window, longer than the upload deadline. Files can briefly persist while an already-open download or aborted Worker closes; no new access is authorized after expiry. Cleanup does not touch metadata lock files, arbitrary directories or credentials. A dedicated beta marker refuses startup if the target data directory already contains an unrelated private dataset.

Validate the deployed system with an independently created EPUB: HTTPS upload, explicit Start, independent Worker, download, different-cookie not-found, foreign/missing Origin rejection, blocked illustration endpoints, invalid-size handling and persistence across process restart. Validate expiration and stale-lease fences in isolated tests rather than shortening retention of real uploaded books. Do not call this Kindle, Apple Books or Send-to-Kindle device certification.
