import type { Env } from '../types.js';
import {
  fromR2Object,
  generatePropfindResponse,
  InvalidResourcePathError,
  listAll,
  ListingLimitError,
  make_resource_path,
  encodeResourceHref,
} from '../utils/webdavUtils.js';
import { logger } from '../utils/logger.js';
import { generateHTML } from '../utils/templates.js';
import { WEBDAV_METHODS } from '../utils/cors.js';

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_LIST_ITEMS = 1000;

function maxUploadBytes(env: Env): number {
  const configured = Number(env.MAX_UPLOAD_BYTES);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.min(configured, DEFAULT_MAX_UPLOAD_BYTES);
}

function maxListItems(env: Env): number {
  const configured = Number(env.MAX_LIST_ITEMS);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MAX_LIST_ITEMS;
  return Math.min(configured, DEFAULT_MAX_LIST_ITEMS);
}

function safeContentType(value: string | undefined): string {
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    return 'application/octet-stream';
  }
  return value;
}

function downloadHeaders(object: R2Object, contentType: string): Headers {
  return new Headers({
    'Content-Type': contentType,
    'Content-Length': object.size.toString(),
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Content-Disposition': 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: { Allow: WEBDAV_METHODS.join(', ') },
  });
}

export async function handleWebDAV(request: Request, env: Env): Promise<Response> {
  const { BUCKET } = env;

  try {
    switch (request.method) {
      case 'OPTIONS':
        return handleOptions();
      case 'HEAD':
        return await handleHead(request, BUCKET);
      case 'GET':
        return await handleGet(request, BUCKET, env);
      case 'PUT':
        return await handlePut(request, BUCKET, env);
      case 'DELETE':
        return await handleDelete(request, BUCKET);
      case 'MKCOL':
        return await handleMkcol(request, BUCKET);
      case 'PROPFIND':
        return await handlePropfind(request, BUCKET, env);
      case 'COPY':
        return await handleCopy(request, BUCKET);
      case 'MOVE':
        return await handleMove(request, BUCKET);
      default:
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: WEBDAV_METHODS.join(', ') },
        });
    }
  } catch (error) {
    if (error instanceof InvalidResourcePathError) {
      return errorResponse(400, 'Invalid resource path');
    }
    logger.error('WebDAV operation failed:', error instanceof Error ? error.message : 'unknown error');
    return errorResponse(500, 'The WebDAV operation could not be completed');
  }
}

async function handleHead(request: Request, bucket: R2Bucket): Promise<Response> {
  const resourcePath = make_resource_path(request);
  const object = await bucket.head(resourcePath);
  if (!object) return new Response(null, { status: 404 });
  return new Response(null, { status: 200, headers: downloadHeaders(object, safeContentType(object.httpMetadata?.contentType)) });
}

async function handleGet(request: Request, bucket: R2Bucket, env: Env): Promise<Response> {
  const resourcePath = make_resource_path(request);
  if (new URL(request.url).pathname.endsWith('/')) {
    return handleDirectory(bucket, resourcePath, maxListItems(env));
  }

  const object = await bucket.get(resourcePath);
  if (!object) return new Response('Not Found', { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: downloadHeaders(object, safeContentType(object.httpMetadata?.contentType)),
  });
}

async function handleDirectory(bucket: R2Bucket, resourcePath: string, limit: number): Promise<Response> {
  const items: { name: string; href: string }[] = [];
  if (resourcePath !== '') items.push({ name: '📁 ..', href: '../' });

  try {
    for await (const entry of listAll(bucket, resourcePath, limit)) {
      if (entry.key === resourcePath) continue;
      const displayName = entry.key.replace(/\/$/, '').split('/').filter(Boolean).pop() || entry.key;
      const href = `/${entry.key.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${entry.isDirectory ? '/' : ''}`;
      items.push({ name: `${entry.isDirectory ? '📁 ' : '📄 '}${displayName}`, href });
    }
  } catch (error) {
    if (error instanceof ListingLimitError) return errorResponse(507, 'Directory listing limit exceeded');
    throw error;
  }

  return new Response(generateHTML('WebDAV File Browser', items), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'private, no-store',
    },
  });
}

async function handlePut(request: Request, bucket: R2Bucket, env: Env): Promise<Response> {
  const resourcePath = make_resource_path(request);
  if (!resourcePath || resourcePath.endsWith('/')) return errorResponse(405, 'Cannot upload to a collection');

  const limit = maxUploadBytes(env);
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return errorResponse(400, 'Invalid Content-Length');
    if (Number(contentLength) > limit) return errorResponse(413, 'Upload exceeds configured size limit');
  }

  let exceeded = false;
  const body = request.body
    ? request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          totalBytes += chunk.byteLength;
          if (totalBytes > limit) {
            exceeded = true;
            controller.error(new Error('Upload size limit exceeded'));
            return;
          }
          controller.enqueue(chunk);
        },
      }))
    : new Uint8Array();
  let totalBytes = 0;

  try {
    const existing = await bucket.head(resourcePath);
    const uploaded = await bucket.put(resourcePath, body, {
      onlyIf: request.headers,
      httpMetadata: { contentType: safeContentType(request.headers.get('Content-Type') ?? undefined) },
    });
    if (!uploaded) return errorResponse(412, 'Upload precondition failed');
    return new Response(null, { status: existing ? 204 : 201 });
  } catch (error) {
    if (exceeded) return errorResponse(413, 'Upload exceeds configured size limit');
    logger.error('Upload failed:', error instanceof Error ? error.message : 'unknown error');
    return errorResponse(500, 'Upload failed');
  }
}

async function handleDelete(request: Request, bucket: R2Bucket): Promise<Response> {
  const resourcePath = make_resource_path(request);
  if (!resourcePath) return errorResponse(405, 'Cannot delete the collection root');

  if (request.headers.has('If-Match') || request.headers.has('If-None-Match') ||
      request.headers.has('If-Unmodified-Since') || request.headers.has('If-Modified-Since')) {
    return errorResponse(501, 'Conditional DELETE is not supported by the R2 binding');
  }

  const object = await bucket.head(resourcePath);
  const possibleCollectionPath = resourcePath.endsWith('/') ? resourcePath : `${resourcePath}/`;
  const isCollection = resourcePath.endsWith('/') ||
    object?.customMetadata?.resourcetype === 'collection' ||
    (!object && await hasObjectsWithPrefix(bucket, possibleCollectionPath));
  if (isCollection) {
    return errorResponse(501, 'Collection DELETE is not supported; no objects were deleted');
  }
  if (!object) return errorResponse(404, 'Not Found');

  await bucket.delete(resourcePath);
  return new Response(null, { status: 204 });
}

async function hasObjectsWithPrefix(bucket: R2Bucket, prefix: string): Promise<boolean> {
  const result = await bucket.list({ prefix, limit: 1 });
  return result.objects.length > 0 || result.truncated;
}

async function collectionExists(bucket: R2Bucket, path: string): Promise<boolean> {
  if (!path) return true;
  const prefix = `${path.replace(/\/+$/, '')}/`;
  const marker = await bucket.head(prefix);
  if (marker?.customMetadata?.resourcetype === 'collection') return true;
  return hasObjectsWithPrefix(bucket, prefix);
}

async function handleMkcol(request: Request, bucket: R2Bucket): Promise<Response> {
  const resourcePath = make_resource_path(request).replace(/\/+$/, '');
  if (!resourcePath) return errorResponse(405, 'Cannot create the collection root');

  const markerPath = `${resourcePath}/`;
  const [existingFile, existingMarker, hasChildren] = await Promise.all([
    bucket.head(resourcePath),
    bucket.head(markerPath),
    hasObjectsWithPrefix(bucket, markerPath),
  ]);
  if (existingFile || existingMarker || hasChildren) {
    return errorResponse(405, 'The resource or collection already exists');
  }

  const parentPath = resourcePath.split('/').slice(0, -1).join('/');
  if (parentPath && !(await collectionExists(bucket, parentPath))) {
    return errorResponse(409, 'Parent collection does not exist');
  }

  const created = await bucket.put(markerPath, new Uint8Array(), {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    customMetadata: { resourcetype: 'collection' },
  });
  if (!created) return errorResponse(405, 'Collection already exists');
  return new Response(null, { status: 201 });
}

async function handlePropfind(request: Request, bucket: R2Bucket, env: Env): Promise<Response> {
  const resourcePath = make_resource_path(request);
  const depth = (request.headers.get('Depth') ?? 'infinity').trim().toLowerCase();
  if (!['0', '1', 'infinity'].includes(depth)) return errorResponse(400, 'Invalid Depth header');
  if (depth === 'infinity') return errorResponse(403, 'Depth: infinity is not supported');

  const object = resourcePath ? await bucket.head(resourcePath) : null;
  const collectionPath = resourcePath ? `${resourcePath.replace(/\/+$/, '')}/` : '';
  let isCollection = resourcePath === '' || Boolean(
    object && (object.key.endsWith('/') || object.customMetadata?.resourcetype === 'collection'),
  );
  if (!object && resourcePath) {
    isCollection = await hasObjectsWithPrefix(bucket, collectionPath);
  }
  if (resourcePath && !object && !isCollection) return errorResponse(404, 'Not Found');

  const responsePath = isCollection && resourcePath ? collectionPath : resourcePath;
  const props = [{
    ...fromR2Object(object),
    resourcetype: isCollection ? 'collection' : (object?.customMetadata?.resourcetype ?? ''),
    href: encodeResourceHref(responsePath),
  }];

  if (depth === '1' && isCollection) {
    const seen = new Set<string>([encodeResourceHref(responsePath)]);
    try {
      for await (const entry of listAll(bucket, responsePath, maxListItems(env))) {
        if (entry.key === responsePath) continue;
        const href = encodeResourceHref(entry.key);
        if (seen.has(href)) continue;
        seen.add(href);
        const displayName = entry.key.replace(/\/$/, '').split('/').filter(Boolean).pop();
        if (entry.object) {
          const childProps = fromR2Object(entry.object);
          if (entry.isDirectory) childProps.resourcetype = 'collection';
          props.push({ ...childProps, href });
        } else {
          const now = new Date().toUTCString();
          props.push({
            creationdate: now,
            displayname: displayName,
            getcontentlanguage: undefined,
            getcontentlength: '0',
            getcontenttype: undefined,
            getetag: undefined,
            getlastmodified: now,
            resourcetype: 'collection',
            href,
          });
        }
      }
    } catch (error) {
      if (error instanceof ListingLimitError) return errorResponse(507, 'PROPFIND listing limit exceeded');
      throw error;
    }
  }

  const xml = generatePropfindResponse(env.BUCKET_NAME ?? 'webdav', resourcePath, props);
  return new Response(xml, {
    status: 207,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

function destinationPath(request: Request): string {
  const destinationHeader = request.headers.get('Destination');
  if (!destinationHeader) throw new InvalidResourcePathError('Destination header is required');

  let destination: URL;
  try {
    destination = new URL(destinationHeader, request.url);
  } catch {
    throw new InvalidResourcePathError('Invalid Destination header');
  }
  if (destination.origin !== new URL(request.url).origin ||
      destination.username || destination.password || destination.search || destination.hash) {
    throw new InvalidResourcePathError('Invalid or cross-origin COPY/MOVE destination');
  }
  const path = make_resource_path(new Request(destination));
  if (!path) throw new InvalidResourcePathError('Destination cannot be the collection root');
  return path;
}

function overwriteAllowed(request: Request): boolean | null {
  const value = request.headers.get('Overwrite');
  if (value === null || value.toUpperCase() === 'T') return true;
  if (value.toUpperCase() === 'F') return false;
  return null;
}

async function handleCopy(request: Request, bucket: R2Bucket): Promise<Response> {
  const sourcePath = make_resource_path(request);
  const targetPath = destinationPath(request);
  if (!sourcePath) return errorResponse(405, 'Cannot copy the collection root');
  if (sourcePath.endsWith('/') || targetPath.endsWith('/')) {
    return errorResponse(501, 'Collection COPY is not supported');
  }
  if (sourcePath === targetPath) return errorResponse(403, 'Source and destination are identical');

  const overwrite = overwriteAllowed(request);
  if (overwrite === null) return errorResponse(400, 'Invalid Overwrite header');

  const source = await bucket.get(sourcePath);
  if (!source) {
    if (await collectionExists(bucket, sourcePath)) {
      return errorResponse(501, 'Collection COPY is not supported');
    }
    return errorResponse(404, 'Source not found');
  }
  if (!('body' in source) || !source.body) return errorResponse(412, 'Source precondition failed');
  if (source.key.endsWith('/') || source.customMetadata?.resourcetype === 'collection') {
    return errorResponse(501, 'Collection COPY is not supported');
  }
  if (await collectionExists(bucket, targetPath)) {
    return errorResponse(409, 'Destination is a collection');
  }

  const existingTarget = await bucket.head(targetPath);
  const options = {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
    ...(!overwrite ? { onlyIf: new Headers({ 'If-None-Match': '*' }) } : {}),
  };
  const copied = await bucket.put(targetPath, source.body, options);
  if (!copied) return errorResponse(412, 'Destination already exists');
  return new Response(null, { status: existingTarget ? 204 : 201 });
}

async function handleMove(request: Request, _bucket: R2Bucket): Promise<Response> {
  const sourcePath = make_resource_path(request);
  const targetPath = destinationPath(request);
  if (sourcePath === targetPath) return new Response(null, { status: 204 });
  return errorResponse(501, 'MOVE is disabled because the R2 binding cannot conditionally delete a source object');
}
