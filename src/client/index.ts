import { createClient as _createClient } from "@kagii/openauth/client";

export const COOKIE_NAME = "oauth_client_id" as const;

export const createClient = ({
	clientID,
	issuer,
}: {
	clientID: string;
	issuer: string;
}) =>
	_createClient({
		clientID,
		issuer,
		fetch(input: RequestInfo, init?: RequestInit) {
			const header = new Headers((init?.headers as Headers) || {});
			header.append("Cookie", `${COOKIE_NAME}=${clientID}`);
			return fetch(input, {
				...init,
				headers: header,
			});
		},
	});
