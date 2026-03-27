import type { Project } from "openauth-webui-shared-types";

export function getTokenFromRequest(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return null;
	}
	return header.slice("Bearer ".length).trim();
}

export async function getSecretFromRequest(
	request: Request,
	project: Project,
): Promise<{
	secret?: string;
	error?: "invalid_timestamp" | "invalid_signature" | "missing_credentials";
}> {
	const timestamp = request.headers.get("X-Client-Timestamp");
	const signature = request.headers.get("X-Client-Signature");
	if (!timestamp || !signature) {
		return { error: "missing_credentials" };
	}

	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
		return { error: "invalid_timestamp" };
	}

	const encoder = new TextEncoder();
	const keyData = encoder.encode(project.secret);
	const messageData = encoder.encode(`${timestamp}:${project.clientID}`);

	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	const matches = signature.match(/.{1,2}/g);
	if (!matches) return { error: "invalid_signature" };
	const sigBuffer = new Uint8Array(matches.map((byte) => parseInt(byte, 16)));

	const isValid = await crypto.subtle.verify(
		"HMAC",
		cryptoKey,
		sigBuffer,
		messageData,
	);

	return isValid ? { secret: project.secret } : { error: "invalid_signature" };
}
