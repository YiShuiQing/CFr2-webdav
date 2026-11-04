import { handleRequest } from './handlers/requestHandler.js';
import type { Env } from './types.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
