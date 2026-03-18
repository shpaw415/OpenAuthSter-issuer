import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Project } from "openauth-webui-shared-types";
import { getTokenFromRequest } from "./shared";
import type { Params } from "./types";

export class PartialRequestError extends Error {
	status: ContentfulStatusCode;
	constructor(message: string, status: ContentfulStatusCode) {
		super(message);
		this.status = status;
	}
}

export class RequestError extends Error {
	status: ContentfulStatusCode;
	params?: Params;
	project?: Project;
	endpoint?: string;
	token: boolean = false;
	secret: boolean = false;
	log: boolean = true;
	response: {
		body?: BodyInit;
		init?: ResponseInit;
	} | null = null;
	constructor({
		message,
		status,
		params,
		project,
		endpoint,
		log = true,
		request,
		responseInit,
	}: {
		message: string;
		status: ContentfulStatusCode;
		params?: Params;
		project?: Project;
		endpoint?: string;
		log?: boolean;
		request: Request;
		responseInit?: {
			body?: BodyInit;
			init?: ResponseInit;
		};
	}) {
		super(message);
		this.status = status;
		this.params = params;
		this.project = project;
		this.endpoint = endpoint;
		this.log = log;
		this.token = getTokenFromRequest(request) ? true : false;
		this.secret =
			request.headers.get("X-Client-Signature") &&
			request.headers.get("X-Client-Timestamp")
				? true
				: false;
		this.response = responseInit ? responseInit : null;
	}
}
