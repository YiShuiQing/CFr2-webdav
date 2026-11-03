import type { Env } from '../types.js';
import {
  fromR2Object,
  generatePropfindResponse,
  InvalidResourcePathError,
  listAll,
  ListingLimitError,
  make_resource_path,
} from '../utils/webdavUtils.js';
import { logger } from '../utils/logger.js';
import { generateHTML } from '../utils/templates.js';
import { WEBDAV_METHODS } from '../utils/cors.js';

const DAV_CLASS = '1, 2';
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
  if (!value || value.length > 200 || /[\r\n\u0000]/.test(value)) {
    return 'application/octet-stream';
  }
  return value;
}

function downloadHeaders(object: R2Object, contentType: string): Headers {
  return new Headers({
    'Content-Type': contentType,
    'Content-Length': object.size.toString(),
    ETag: object.etag,
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
    headers: { Allow: WEBDAV_METHODS.join(', '), DAV: DAV_CLASS },
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
          headers: { Allow: WEBDAV_METHODS.join(', '), DAV: DAV_CLASS },
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
    for await (const object of listAll(bucket, resourcePath, limit)) {
      if (object.key === resourcePath) continue;
      const isDirectory = object.customMetadata?.resourcetype === 'collection';
      const displayName = object.key.split('/').filter(Boolean).pop() || object.key;
      const href = `/${object.key.split('/').map(encodeURIComponent).join('/')}${isDirectory ? '/' : ''}`;
      items.push({ name: `${isDirectory ? '📁 ' : '📄 '}${displayName}`, href });
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
  if (!resourcePath) return errorResponse(405, 'Cannot upload to the collection root');

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
    await bucket.put(resourcePath, body, {
      httpMetadata: { contentType: safeContentType(request.headers.get('Content-Type') ?? undefined) },
    });
    return new Response('Created', { status: 201 });
  } catch (error) {
    if (exceeded) return errorResponse(413, 'Upload exceeds configured size limit');
    logger.error('Upload failed:', error instanceof Error ? error.message : 'unknown error');
    return errorResponse(500, 'Upload failed');
  }
}

async function handleDelete(request: Request, bucket: R2Bucket): Promise<Response> {
  const resourcePath = make_resource_path(request);
  if (!resourcePath) return errorResponse(405, 'Cannot delete the collection root');
  await bucket.delete(resourcePath);
  return new Response(null, { status: 204 });
}

async function handleMkcol(request: Request, bucket: R2Bucket): Promise<Response> {
  const resourcePath = make_resource_path(request).replace(/\/$/, '');
  if (!resourcePath) return errorResponse(405, 'Cannot create the collection root');
  const existing = await bucket.head(`${resourcePath}/`);
  if (existing) return errorResponse(405, 'Collection already exists');
  await bucket.put(`${resourcePath}/`, new Uint8Array(), {
    customMetadata: { resourcetype: 'collection' },
  });
  return new Response('Created', { status: 201 });
}

async function handlePropfind(request: Request, bucket: R2Bucket, env: Env): Promise<Response> {
  const resourcePath = make_resource_path(request);
  const depth = (request.headers.get('Depth') ?? 'infinity').toLowerCase();
  if (!['0', '1', 'infinity'].includes(depth)) return errorResponse(400, 'Invalid Depth header');

  const props = [];
  if (depth === '0') {
    const object = await bucket.head(resourcePath);
    if (!object && resourcePath !== '') return errorResponse(404, 'Not Found');
    props.push(fromR2Object(object));
  } else {
    try {
      for await (const object of listAll(bucket, resourcePath, maxListItems(env))) {
        props.push(fromR2Object(object));
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
  if (destination.origin !== new URL(request.url).origin) {
    throw new InvalidResourcePathError('Cross-origin COPY/MOVE is not allowed');
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
  if (sourcePath === targetPath) return errorResponse(403, 'Source and destination are identical');
  const overwrite = overwriteAllowed(request);
  if (overwrite === null) return errorResponse(400, 'Invalid Overwrite header');

  const source = await bucket.get(sourcePath);
  if (!source) return errorResponse(404, 'Source not found');
  const target = await bucket.head(targetPath);
  if (target && !overwrite) return errorResponse(412, 'Destination already exists');

  await bucket.put(targetPath, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  return new Response(null, { status: target ? 204 : 201 });
}

async function handleMove(request: Request, bucket: R2Bucket): Promise<Response> {
  const sourcePath = make_resource_path(request);
  const targetPath = destinationPath(request);
  const overwrite = overwriteAllowed(request);
  if (overwrite === null) return errorResponse(400, 'Invalid Overwrite header');

  const source = await bucket.get(sourcePath);
  if (!source) return errorResponse(404, 'Source not found');
  if (sourcePath === targetPath) return new Response(null, { status: 204 });

  const target = await bucket.head(targetPath);
  if (target && !overwrite) return errorResponse(412, 'Destination already exists');

  await bucket.put(targetPath, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  await bucket.delete(sourcePath);
  return new Response(null, { status: target ? 204 : 201 });
}
