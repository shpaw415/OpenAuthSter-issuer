import type { Context } from "hono";
import type { Project } from "openauth-webui-shared-types";
import type { InferInput } from "valibot";
import type { subjects } from "../../openauth.config";

export type EndpointCtx = Context<{
	Bindings: Env;
	Variables: EndpointVariables;
}>;

export type EndpointVariables = {
	params: Params;
	project: Project;
	userInfo: InferInput<(typeof subjects)["user"]>;
	requireMFA: boolean;
};

export type Params = {
	clientID: string | null;
	copyID: string | null;
	inviteID: string | null;
	url: URL;
};
