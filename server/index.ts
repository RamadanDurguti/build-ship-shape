/**
 * The Supabase Edge Function entry point.
 *
 * Deliberately five lines: everything above it is a plain Request -> Response
 * function with no runtime-specific code in it, which is what makes the whole
 * MCP surface testable on a laptop before it is ever deployed.
 */
import { createApp } from './app.js';
import { postgrestStore } from './store.js';

const store = postgrestStore(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(createApp(store));
