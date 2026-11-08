import { app, createDeps, handleScheduled } from './app';
import type { Bindings } from './config/env';

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(createDeps(env), controller.cron, controller.scheduledTime));
  },
} satisfies ExportedHandler<Bindings>;
