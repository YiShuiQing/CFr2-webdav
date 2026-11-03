import type { Env } from '../types.js';
import { handleWebDAV } from './webdavHandler.js';
import { authenticate, isAuthenticationConfigured } from '../utils/auth.js';
import {
  handleCorsPreflight,
  isOriginAllowed,
  setCORSHeaders,
} from '../utils/cors.js';
import { InvalidResourcePathError } from '../utils/webdavUtils.js';
import { logger } from '../utils/logger.js';

export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  try {
    if (!isOriginAllowed(request, env)) {
      return new Response('Forbidden origin', { status: 403 });
    }

    const preflight = handleCorsPreflight(request, env);
    if (preflight) return preflight;

    if (!isAuthenticationConfigured(env)) {
      return new Response('WebDAV authentication is not configured', { status: 503 });
    }

    if (!authenticate(request, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="WebDAV", charset="UTF-8"' },
      });
    }

    const response = await handleWebDAV(request, env);
    setCORSHeaders(response, request, env);
    return response;
  } catch (error) {
    if (error instanceof InvalidResourcePathError) {
      return new Response('Bad Request: invalid resource path', { status: 400 });
    }
    logger.error('Error in request handling:', error instanceof Error ? error.message : 'unknown error');
    return new Response('Internal Server Error', { status: 500 });
  }
}
