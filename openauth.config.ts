import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string, any, type InferOutput } from "valibot";
import { createExternalGlobalProjectConfig } from "openauth-webui-shared-types";

export default async (env: Env) =>
  createExternalGlobalProjectConfig<InferOutput<typeof subjects.user>>({
    register: {
      fallbackEmailFrom: "fallback@example.com",
      onSuccessfulRegistration(ctx, value, request) {
        //console.log(ctx, value);
      },
      strategy: {
        email: {
          provider: "custom",
          sendEmailFunction(to, code) {
            console.log(`Send code ${code} to email ${to}`);
          },
        },
      },
    },
  });

// This value should be shared between the OpenAuth server Worker and other
// client Workers that you connect to it, so the types and schema validation are
// consistent.
export const subjects = createSubjects({
  user: object({
    id: string(),
    data: any(),
    clientID: string(),
    provider: string(),
  }),
});
