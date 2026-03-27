import { describe, expect, it } from "bun:test";
import { SandBox } from "../src/sandbox.mts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const sb = await SandBox.create();

const createSandboxedFunction = (body: string) =>
	sb.createSandboxedFunction(body);

/** Calls the sandboxed body with the given props and returns the result. */
function run(body: string, props: Record<string, unknown> = {}): unknown {
	return sb.createSandboxedFunction(body)(props);
}

/**
 * Asserts host isolation: the returned value must NOT be the real host object.
 * Acceptable outcomes are: throws (ReferenceError wrapped in Error), returns
 * undefined, returns null, or returns a safe QuickJS-owned value that is
 * provably not the host object.
 */
function assertNotHostObject(
	body: string,
	hostValue: unknown,
	props: Record<string, unknown> = {},
): void {
	try {
		const result = run(body, props);
		expect(result).not.toBe(hostValue);
	} catch (e) {
		// Throwing is also acceptable — the identifier didn't exist in the VM.
		expect(e).toBeInstanceOf(Error);
	}
}

// ─── Functional correctness ──────────────────────────────────────────────────

describe("functional correctness", () => {
	it("returns a primitive value", () => {
		expect(run("return 42;")).toBe(42);
	});

	it("reads from props", () => {
		expect(run("return props.name;", { name: "Alice" })).toBe("Alice");
	});

	it("can use Math", () => {
		expect(run("return Math.max(1, 2, 3);")).toBe(3);
	});

	it("can use JSON", () => {
		expect(run("return JSON.stringify({a:1});")).toBe('{"a":1}');
	});

	it("can use parseInt / parseFloat", () => {
		expect(run('return parseInt("42px", 10);')).toBe(42);
		expect(run('return parseFloat("3.14");')).toBeCloseTo(3.14);
	});

	it("can use Array / String / Number helpers", () => {
		expect(run("return Array.isArray([]);")).toBe(true);
		expect(run("return String(99);")).toBe("99");
		expect(run('return Number("7");')).toBe(7);
	});

	it("can use encodeURIComponent / decodeURIComponent", () => {
		expect(run('return encodeURIComponent("a b");')).toBe("a%20b");
	});

	it("throws a clear Error on syntax error", () => {
		expect(() => createSandboxedFunction("{{{{")).toThrow(
			/Invalid template function body/,
		);
	});

	it("throws a clear Error on runtime error", () => {
		expect(() => run("null.boom();")).toThrow(
			/Template function runtime error/,
		);
	});

	it("sandbox is reusable across multiple calls", () => {
		const fn = createSandboxedFunction("return props.x * 2;");
		expect(fn({ x: 3 })).toBe(6);
		expect(fn({ x: 10 })).toBe(20);
	});
});

// ─── Host isolation — code runs in a separate QuickJS VM ─────────────────────
//
// QuickJS has its own global object. Host globals (fetch, crypto, Cloudflare
// env bindings, etc.) are not present. Accessing them either throws a
// ReferenceError (wrapped in our Error) or returns undefined from the QuickJS
// global — both outcomes are safe.

describe("host isolation", () => {
	// globalThis exists in QuickJS, but it is the QuickJS global, not the host's.
	it("globalThis is not the host globalThis", () => {
		assertNotHostObject("return globalThis;", globalThis);
	});

	it("globalThis has no host fetch", () => {
		const result = run("return globalThis.fetch;");
		expect(result).toBeUndefined();
	});

	it("globalThis has no host crypto", () => {
		const result = run("return globalThis.crypto;");
		expect(result).toBeUndefined();
	});

	it("fetch is not accessible", () => {
		assertNotHostObject("return fetch;", globalThis.fetch);
	});

	it("crypto is not accessible", () => {
		assertNotHostObject(
			"return crypto;",
			(globalThis as Record<string, unknown>).crypto,
		);
	});

	it("eval cannot reach host globals", () => {
		// eval exists in QuickJS but resolves against the QuickJS global — no fetch there.
		const result = run("return eval('typeof fetch');");
		expect(result).toBe("undefined");
	});

	it("process is not the host process", () => {
		assertNotHostObject(
			"return process;",
			(globalThis as Record<string, unknown>).process,
		);
	});

	it("setTimeout / setInterval are not accessible", () => {
		assertNotHostObject("return setTimeout;", globalThis.setTimeout);
		assertNotHostObject("return setInterval;", globalThis.setInterval);
	});
});

// ─── `this` does not expose host globals ────────────────────────────────────

describe("this isolation", () => {
	it("this.fetch is not the host fetch", () => {
		// In non-strict mode `this` is the QuickJS global, which has no fetch.
		const result = run("return this.fetch;");
		expect(result).toBeUndefined();
	});

	it("this.globalThis is not the host globalThis", () => {
		assertNotHostObject("return this.globalThis;", globalThis);
	});
});

// ─── Constructor chain escapes ───────────────────────────────────────────────
//
// Even if user code reaches QuickJS's own Function via constructor chains, that
// Function only has access to the QuickJS global — not to host fetch, env, etc.

describe("constructor chain escapes", () => {
	it("(1).constructor.constructor('return fetch')() is not host fetch", () => {
		// QuickJS's Function can be reached, but `fetch` inside QuickJS is undefined.
		assertNotHostObject(
			"return (1).constructor.constructor('return fetch')();",
			globalThis.fetch,
		);
	});

	it("Function constructor cannot return host eval", () => {
		assertNotHostObject(
			"return (function(){}).constructor('return eval')();",
			(globalThis as Record<string, unknown>)["eval"],
		);
	});

	it("Object constructor chain cannot reach host globalThis", () => {
		assertNotHostObject(
			"return ({}).constructor.constructor('return globalThis')();",
			globalThis,
		);
	});
});

// ─── Prototype isolation ──────────────────────────────────────────────────────
//
// User code runs in QuickJS's own VM — its Object.prototype is completely
// separate from the host's. Mutations inside the VM cannot affect the host.

describe("prototype isolation", () => {
	const poisonKey = "__sandbox_test_injected__";

	it("cannot pollute host Object.prototype", () => {
		run(`try { Object.prototype["${poisonKey}"] = true; } catch(e) {}`);
		expect(
			(Object.prototype as Record<string, unknown>)[poisonKey],
		).toBeUndefined();
	});

	it("cannot pollute host Array.prototype", () => {
		run(`try { Array.prototype["${poisonKey}"] = true; } catch(e) {}`);
		expect(
			(Array.prototype as unknown as Record<string, unknown>)[poisonKey],
		).toBeUndefined();
	});

	it("cannot pollute host Function.prototype", () => {
		run(`try { Function.prototype["${poisonKey}"] = true; } catch(e) {}`);
		expect(
			(Function.prototype as unknown as Record<string, unknown>)[poisonKey],
		).toBeUndefined();
	});
});

// ─── Props injection safety ───────────────────────────────────────────────────
//
// Props are passed as JSON literals. Even adversarial prop values cannot inject
// code because JSON.stringify always produces safely escaped output.

describe("props injection safety", () => {
	it("adversarial string prop cannot inject code", () => {
		// If props.x were interpolated unsafely, this would throw or return 42.
		// JSON.stringify escapes it, so it's just a string.
		const result = run("return typeof props.x;", {
			x: "})(globalThis); (function(props){",
		});
		expect(result).toBe("string");
	});

	it("props with newlines and quotes are passed safely", () => {
		const value = 'line1\nline2"end';
		const result = run("return props.v;", { v: value });
		expect(result).toBe(value);
	});
});

// ─── Confirm standard globals are available ───────────────────────────────────

describe("standard globals are available inside the VM", () => {
	const cases: [string, string][] = [
		["Math.PI", "number"],
		["JSON.parse", "function"],
		["parseInt", "function"],
		["parseFloat", "function"],
		["isNaN", "function"],
		["isFinite", "function"],
		["encodeURIComponent", "function"],
		["decodeURIComponent", "function"],
		["Array.isArray", "function"],
		["Object.keys", "function"],
		["String.fromCharCode", "function"],
		["Number.isInteger", "function"],
		["Boolean", "function"],
		["Date", "function"],
	];

	for (const [expr, expectedType] of cases) {
		it(`typeof ${expr} === "${expectedType}" inside the VM`, () => {
			// Evaluate `typeof` inside QuickJS — QuickJS function handles dump as
			// the string "function" on the host side, so we ask QuickJS directly.
			expect(run(`return typeof ${expr};`)).toBe(expectedType);
		});
	}
});
