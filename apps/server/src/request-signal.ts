import type { FastifyReply, FastifyRequest } from 'fastify';

const controllers = new WeakMap<FastifyRequest, AbortController>();

/** Called once per request, before its handler: the signal aborts if the client goes away. */
export function watchRequest(request: FastifyRequest, reply: FastifyReply): void {
  const controller = new AbortController();
  controllers.set(request, controller);
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
}

/** Aborts when the client disconnects before the reply is sent, so calls nobody waits for stop. */
export function requestSignal(request: FastifyRequest): AbortSignal {
  return (controllers.get(request) ?? new AbortController()).signal;
}
