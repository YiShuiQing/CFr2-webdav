import type { R2Object } from '@cloudflare/workers-types';
import type { WebDAVProps } from '../types.js';

export class InvalidResourcePathError extends Error {
  constructor(message = 'Invalid resource path') {
    super(message);
    this.name = 'InvalidResourcePathError';
  }
}

export class ListingLimitError extends Error {
  constructor() {
    super('Directory listing limit exceeded');
    this.name = 'ListingLimitError';
  }
}

export function make_resource_path(request: Request): string {
  const pathname = new URL(request.url).pathname.slice(1);
  if (/%(?:2f|5c)/i.test(pathname)) {
    throw new InvalidResourcePathError('Encoded path separators are not allowed');
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new InvalidResourcePathError('Malformed URL encoding');
  }

  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) {
    throw new InvalidResourcePathError('Control characters and backslashes are not allowed');
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new InvalidResourcePathError('Dot path segments are not allowed');
  }
  return decoded;
}

export interface R2DirectoryEntry {
  key: string;
  object: R2Object | null;
  isDirectory: boolean;
}

export async function* listAll(
  bucket: R2Bucket,
  prefix: string,
  maxItems = 1000,
): AsyncGenerator<R2DirectoryEntry> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(maxItems)));
  const options = { prefix, delimiter: '/', limit: safeLimit, include: ['customMetadata'] as ['customMetadata'] };
  let cursor: string | undefined;
  let count = 0;
  const seen = new Set<string>();

  while (true) {
    const result = await bucket.list(cursor ? { ...options, cursor } : options);
    for (const object of result.objects) {
      if (seen.has(object.key)) continue;
      seen.add(object.key);
      count += 1;
      if (count > safeLimit) throw new ListingLimitError();
      yield { key: object.key, object, isDirectory: object.customMetadata?.resourcetype === 'collection' };
    }
    for (const directoryPrefix of result.delimitedPrefixes) {
      if (seen.has(directoryPrefix)) continue;
      seen.add(directoryPrefix);
      count += 1;
      if (count > safeLimit) throw new ListingLimitError();
      yield { key: directoryPrefix, object: null, isDirectory: true };
    }

    if (!result.truncated) break;
    if (!result.cursor || count >= safeLimit) throw new ListingLimitError();
    cursor = result.cursor;
  }
}

export function fromR2Object(object: R2Object | null): WebDAVProps {
  if (!object) {
    const now = new Date().toUTCString();
    return {
      creationdate: now,
      displayname: undefined,
      getcontentlanguage: undefined,
      getcontentlength: '0',
      getcontenttype: undefined,
      getetag: undefined,
      getlastmodified: now,
      resourcetype: 'collection',
    };
  }

  return {
    creationdate: object.uploaded.toISOString(),
    displayname: object.key.split('/').filter(Boolean).pop(),
    getcontentlanguage: object.httpMetadata?.contentLanguage,
    getcontentlength: object.size.toString(),
    getcontenttype: object.httpMetadata?.contentType,
    getetag: object.httpEtag,
    getlastmodified: object.uploaded.toUTCString(),
    resourcetype: object.customMetadata?.resourcetype || '',
  };
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function encodeResourceHref(resourcePath: string): string {
  const segments = resourcePath.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment));
  return segments.length ? `/${segments.join('/')}${resourcePath.endsWith('/') ? '/' : ''}` : '/';
}

export function generatePropfindResponse(
  bucketName: string,
  basePath: string,
  props: WebDAVProps[],
): string {
  const responses = props.map((prop) => {
    const href = escapeXml(prop.href ?? encodeResourceHref(basePath));
    const resourceType = prop.resourcetype ? '<D:collection/>' : '';
    return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:creationdate>${escapeXml(prop.creationdate)}</D:creationdate>
        <D:displayname>${escapeXml(prop.displayname)}</D:displayname>
        <D:getcontentlength>${escapeXml(prop.getcontentlength)}</D:getcontentlength>
        <D:getcontenttype>${escapeXml(prop.getcontenttype)}</D:getcontenttype>
        <D:getetag>${escapeXml(prop.getetag)}</D:getetag>
        <D:getlastmodified>${escapeXml(prop.getlastmodified)}</D:getlastmodified>
        <D:resourcetype>${resourceType}</D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;
}
