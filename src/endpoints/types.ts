import { Project } from "openauth-webui-shared-types";
import { InferInput } from "valibot";
import { subjects } from "../../openauth.config";
import type { Context } from "hono";

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
