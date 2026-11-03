import type { Env } from '../types.js';

const MAX_AUTHORIZATION_LENGTH = 8192;

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

export function isAuthenticationConfigured(env: Env): boolean {
  return Boolean(
    env.USERNAME &&
    env.PASSWORD &&
    !env.USERNAME.includes(':') &&
    env.PASSWORD.length >= 20
  );
}

export function authenticate(request: Request, env: Env): boolean {
  if (!isAuthenticationConfigured(env)) return false;

  const authorization = request.headers.get('Authorization');
  if (!authorization || authorization.length > MAX_AUTHORIZATION_LENGTH) {
    return false;
  }

  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization.trim());
  if (!match) return false;

  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator <= 0) return false;

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return (
      constantTimeEqual(username, env.USERNAME!) &&
      constantTimeEqual(password, env.PASSWORD!)
    );
  } catch {
    return false;
  }
}
