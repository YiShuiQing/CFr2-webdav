# Cloudflare R2 WebDAV (security-hardened fork)

A WebDAV-compatible Cloudflare Worker backed by the existing R2 bucket named `webdav`.

## Security behavior

- `USERNAME` and `PASSWORD` are mandatory Worker Secrets; no default credentials. Missing or invalid configuration fails closed with HTTP 503.
- Cross-origin browser access is disabled by default. If required, set `CORS_ORIGINS` to exact comma-separated HTTPS origins. Wildcards are unsupported.
- Unapproved Origin headers are rejected. CORS never reflects arbitrary origins and does not enable credential cookies.
- Directory HTML escapes untrusted names and links. File GET/HEAD responses use attachment disposition, `nosniff`, and private/no-store caching.
- PROPFIND XML values are escaped and href path segments URL-encoded.
- Uploads are streamed directly from the original known-length request body to R2 with a 100 MiB Content-Length cap. Requests with a non-empty body but no Content-Length are rejected with 411 because R2 requires a known-length stream. Directory/PROPFIND enumeration requests R2 HTTP and custom metadata, recognizes both explicit and implicit directories, and is capped at 1,000 entries.
- Resource paths reject encoded separators, backslashes, control characters, malformed encodings, and dot segments.
- COPY is limited to individual files, enforces same-origin destinations, and atomically honors `Overwrite: F`. MOVE is disabled (501) because the Workers R2 binding has no conditional delete operation; collection COPY/DELETE are also rejected rather than partially modifying a directory. `Depth: infinity` is rejected (403); `DAV: 1` is advertised, not Class 2.
- Conditional PUT requests are enforced atomically by the R2 binding. Conditional DELETE is rejected because the binding does not provide conditional deletes.
- No distributed IP rate limiter is implemented. Configure Cloudflare rate-limiting/WAF rules on a custom hostname for public exposure; do not assume equivalent WAF controls on the default workers.dev hostname.

## Existing R2 bucket

The Wrangler configuration binds the existing bucket:

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "webdav"
```

Deployment does not create, empty, migrate, or delete the bucket or its objects. Worker script name: `cf-r2-webdav`.

## GitHub Actions secrets

Add repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Target account ID |
| `USERNAME` | WebDAV Basic Auth username; cannot contain colon |
| `PASSWORD` | WebDAV password, minimum 20 characters |

Do not commit credentials or print them in Actions logs. The `Deploy to Cloudflare Workers` workflow is manual-only, runs from `main`, and requires an explicit production confirmation. It deploys the Worker, then writes `USERNAME` and `PASSWORD` as Worker Secrets. Configure the GitHub `production` environment with required reviewers before using it. Verification workflows and pull requests never deploy. The Worker returns 503 until both credentials are configured as Worker Secrets.

## Local development

Run `npm ci`, `npm run typecheck`, and `npm test`. For local development, place credentials in an untracked `.dev.vars` file.

## Limits

`MAX_UPLOAD_BYTES` and `MAX_LIST_ITEMS` can lower defaults. Hard maximums are 100 MiB and 1,000 objects.
