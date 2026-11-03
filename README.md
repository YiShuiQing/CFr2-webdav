# Cloudflare R2 WebDAV (security-hardened fork)

A WebDAV-compatible Cloudflare Worker backed by the existing R2 bucket named `webdav`.

## Security behavior

- `USERNAME` and `PASSWORD` are mandatory Worker Secrets; no default credentials. Missing or invalid configuration fails closed with HTTP 503.
- Cross-origin browser access is disabled by default. If required, set `CORS_ORIGINS` to exact comma-separated HTTPS origins. Wildcards are unsupported.
- Unapproved Origin headers are rejected. CORS never reflects arbitrary origins and does not enable credential cookies.
- Directory HTML escapes untrusted names and links. File GET/HEAD responses use attachment disposition, `nosniff`, and private/no-store caching.
- PROPFIND XML values are escaped and href path segments URL-encoded.
- Uploads are streamed with a 100 MiB hard cap. Directory/PROPFIND enumeration is capped at 1,000 objects.
- Resource paths reject encoded separators, backslashes, control characters, malformed encodings, and dot segments.
- COPY/MOVE are same-origin only and honor `Overwrite: T/F`. MOVE to the same path is a no-op.
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

Do not commit credentials or print them in Actions logs. Only pushes to `main` deploy; security branches and pull requests run verification only. First deployment creates the Worker, then stores USERNAME/PASSWORD with `wrangler secret put`. The Worker returns 503 until both are present.

## Local development

Run `npm ci`, `npm run typecheck`, and `npm test`. For local development, place credentials in an untracked `.dev.vars` file.

## Limits

`MAX_UPLOAD_BYTES` and `MAX_LIST_ITEMS` can lower defaults. Hard maximums are 100 MiB and 1,000 objects.
