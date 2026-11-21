// Shared helpers for tool handlers.
import { CdpError } from './cdp.js';

// Successful tool result: compact JSON text only. (No structuredContent: we declare no outputSchema,
// and clients like OpenClaw may forward both copies to the model, doubling tokens.)
export function ok(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// Error tool result the model can read and react to (isError: true, stable error code).
export function fail(code, message, details) {
  const body = { error: code, message };
  if (details !== undefined) body.details = details;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

// Wrap a handler so thrown errors become readable tool errors instead of protocol errors.
export function safe(handler) {
  return async (args, extra) => {
    try {
      return await handler(args ?? {}, extra);
    } catch (e) {
      if (e instanceof CdpError) {
        // Errors thrown inside the page by the bridge: "CODE: message" convention.
        if (e.code === 'JS_EXCEPTION') {
          // Code must be ALL-CAPS and directly followed by ':' or end, so "TypeError: Cannot…" isn't code "C".
          const m = /Error: ([A-Z][A-Z_]*[A-Z])(?=:|$)(?::\s*(.*))?/m.exec(e.message || '');
          if (m) return fail(m[1], m[2] || m[1]);
        }
        return fail(e.code, e.message);
      }
      return fail('INTERNAL', e?.stack || String(e));
    }
  };
}

export const log = (...a) => console.error('[pmgt-mcp]', ...a); // stdout is reserved for MCP JSON-RPC
