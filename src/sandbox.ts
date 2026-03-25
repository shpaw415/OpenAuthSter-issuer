import { getQuickJS } from "quickjs-emscripten";

// Initialize the QuickJS WASM VM once at module load.
// In Cloudflare Workers (ES module format) and Bun, top-level await is supported.
// User code runs inside an isolated QuickJS context per call, completely separate
// from the host V8 runtime — no shared globals, no shared prototype chain.
const _qjs = await getQuickJS();

/**
 * Compiles a user-supplied function body into a sandboxed callable.
 *
 * Security properties:
 *  - Executes inside an isolated QuickJS (WebAssembly) VM context.
 *  - Has no access to host globals: fetch, globalThis, crypto, env bindings, etc.
 *  - Cannot escape via constructor chains: (1).constructor.constructor is QuickJS's
 *    own Function, not the host's.
 *  - Cannot pollute the host's Object.prototype or any other host prototype.
 *  - props are passed as a JSON literal — injection-safe by construction.
 *  - Syntax errors are caught at compile time; runtime errors are caught and
 *    re-thrown as plain Errors.
 */
export function createSandboxedFunction(
	body: string,
): (props: Record<string, unknown>) => unknown {
	// Validate syntax at parse time so callers get a clear error immediately.
	{
		const ctx = _qjs.newContext();
		try {
			const test = ctx.evalCode(`(function(props) { ${body} })`);
			if (test.error) {
				const msg = ctx.dump(test.error);
				test.error.dispose();
				throw new Error(
					`Invalid template function body: ${JSON.stringify(msg)}`,
				);
			}
			test.value.dispose();
		} finally {
			ctx.dispose();
		}
	}

	return (props: Record<string, unknown>) => {
		// Fresh context per call — no state leaks between invocations.
		const ctx = _qjs.newContext();
		try {
			// JSON.stringify produces only safe JSON literals (strings are always
			// escaped), so this cannot be used for code injection.
			const code = `(function(props) { ${body} })(${JSON.stringify(props)})`;
			const result = ctx.evalCode(code);
			if (result.error) {
				const msg = ctx.dump(result.error);
				result.error.dispose();
				throw new Error(
					`Template function runtime error: ${JSON.stringify(msg)}`,
				);
			}
			const value = ctx.dump(result.value);
			result.value.dispose();
			return value;
		} finally {
			ctx.dispose();
		}
	};
}
