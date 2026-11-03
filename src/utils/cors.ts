import type { Env } from '../types.js';

export const WEBDAV_METHODS = [
  'OPTIONS', 'PROPFIND', 'MKCOL', 'GET', 'HEAD', 'PUT', 'COPY', 'MOVE', 'DELETE',
];

const ALLOWED_HEADERS = [
  'Authorization', 'Content-Type', 'Depth', 'Overwrite', 'Destination', 'Range',
  'If-Match', 'If-None-Match', 'Lock-Token', 'Timeout', 'Content-Language',
];

function configuredOrigins(env: Env): Set<string> {
  return new Set(
    (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isValidOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const localHttp = parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    return (parsed.protocol === 'https:' || localHttp) && parsed.origin === origin;
  } catch {
    return false;
  }
}

export function isOriginAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (!isValidOrigin(origin)) return false;

  try {
    if (new URL(request.url).origin === origin) return true;
  } catch {
    return false;
  }

  return configuredOrigins(env).has(origin);
}

export function handleCorsPreflight(request: Request, env: Env): Response | null {
  if (request.method !== 'OPTIONS') return null;

  const origin = request.headers.get('Origin');
  const headers = new Headers({
    Allow: WEBDAV_METHODS.join(', '),
    DAV: '1, 2',
  });

  if (!origin) return new Response(null, { status: 204, headers });
  if (!isOriginAllowed(request, env)) {
    return new Response('Forbidden origin', { status: 403 });
  }

  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (requestedMethod && !WEBDAV_METHODS.includes(requestedMethod.toUpperCase())) {
    return new Response('Requested method is not allowed', { status: 403 });
  }

  const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaderNames = new Set(ALLOWED_HEADERS.map((header) => header.toLowerCase()));
  if (requestedHeaders.some((header) => !allowedHeaderNames.has(header))) {
    return new Response('Requested header is not allowed', { status: 403 });
  }

  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', WEBDAV_METHODS.join(', '));
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(', '));
  headers.set('Access-Control-Max-Age', '600');
  headers.append('Vary', 'Origin');
  return new Response(null, { status: 204, headers });
}

export function setCORSHeaders(response: Response, request: Request, env: Env): void {
  const origin = request.headers.get('Origin');
  if (!origin || !isOriginAllowed(request, env)) return;

  if (new URL(request.url).origin === origin) return;

  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', WEBDAV_METHODS.join(', '));
  response.headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(', '));
  response.headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, DAV, ETag, Last-Modified, Location, Content-Range',
  );
  response.headers.append('Vary', 'Origin');
}
