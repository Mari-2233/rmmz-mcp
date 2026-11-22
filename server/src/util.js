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

// Wrap a handler so each call is appended to the session transcript (see transcript.js).
// With no transcript configured the handler is returned unchanged. Recording sits outside
// safe(), so it sees the final result, including readable tool errors. Recording failures
// never break a tool call: Transcript.record handles its own errors.
export function recorded(transcript, name, handler) {
  if (!transcript) return handler;
  return async (args, extra) => {
    const t0 = Date.now();
    // Tools without an inputSchema are called by the SDK as handler(extra): the first
    // argument is request context (AbortSignal, requestId, callbacks), not tool arguments.
    // None of this server's tools take a `signal` argument, so treat that shape as no args.
    const toolArgs = args && typeof args === 'object' && 'signal' in args && 'requestId' in args ? {} : (args ?? {});
    let result;
    try {
      result = await handler(args, extra);
    } catch (e) {
      // Handlers wrapped in safe() do not throw today. Record anyway if one ever does.
      transcript.record({ tool: name, args: toolArgs, ok: false, error: 'THREW', ms: Date.now() - t0, result: { error: String(e?.message || e) } });
      throw e;
    }
    let error = null;
    if (result?.isError) {
      try { error = JSON.parse(result.content?.[0]?.text || '{}').error || 'ERROR'; }
      catch { error = 'ERROR'; }
    }
    transcript.record({ tool: name, args: toolArgs, ok: !result?.isError, error, ms: Date.now() - t0, result });
    return result;
  };
}

export const log = (...a) => console.error('[pmgt-mcp]', ...a); // stdout is reserved for MCP JSON-RPC
