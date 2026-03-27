import { describe, expect, it } from "bun:test";
import type { Project } from "openauth-webui-shared-types";
import {
	getSecretFromRequest,
	getTokenFromRequest,
} from "../src/endpoints/shared";

const project = {
	clientID: "client-123",
	secret: "issuer-secret",
} as Project;

async function createSignature(timestamp: string, secret = project.secret) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${timestamp}:${project.clientID}`),
	);

	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

describe("endpoint shared helpers", () => {
	it("extracts a bearer token from the authorization header", () => {
		const token = getTokenFromRequest(
			new Request("http://localhost/session/public", {
				headers: {
					Authorization: "Bearer live-access-token   ",
				},
			}),
		);

		expect(token).toBe("live-access-token");
	});

	it("returns null when the authorization header is missing or malformed", () => {
		expect(
			getTokenFromRequest(new Request("http://localhost/session/public")),
		).toBeNull();
		expect(
			getTokenFromRequest(
				new Request("http://localhost/session/public", {
					headers: {
						Authorization: "Token live-access-token",
					},
				}),
			),
		).toBeNull();
	});

	it("accepts a valid signed issuer request", async () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const signature = await createSignature(timestamp);

		const result = await getSecretFromRequest(
			new Request("http://localhost/session/private", {
				headers: {
					"X-Client-Timestamp": timestamp,
					"X-Client-Signature": signature,
				},
			}),
			project,
		);

		expect(result).toEqual({ secret: "issuer-secret" });
	});

	it("rejects requests with missing HMAC credentials", async () => {
		const result = await getSecretFromRequest(
			new Request("http://localhost/session/private"),
			project,
		);

		expect(result).toEqual({ error: "missing_credentials" });
	});

	it("rejects requests with stale timestamps", async () => {
		const staleTimestamp = (Math.floor(Date.now() / 1000) - 301).toString();
		const signature = await createSignature(staleTimestamp);

		const result = await getSecretFromRequest(
			new Request("http://localhost/session/private", {
				headers: {
					"X-Client-Timestamp": staleTimestamp,
					"X-Client-Signature": signature,
				},
			}),
			project,
		);

		expect(result).toEqual({ error: "invalid_timestamp" });
	});

	it("rejects requests with invalid signatures", async () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();

		const result = await getSecretFromRequest(
			new Request("http://localhost/session/private", {
				headers: {
					"X-Client-Timestamp": timestamp,
					"X-Client-Signature": await createSignature(
						timestamp,
						"wrong-secret",
					),
				},
			}),
			project,
		);

		expect(result).toEqual({ error: "invalid_signature" });
	});
});
