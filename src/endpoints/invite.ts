import { setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
	COOKIE_INVITE_ID,
	insertLog,
	type Project,
	WebUiInviteLinkTable,
} from "openauth-webui-shared-types";
import { drizzle, eq } from "openauth-webui-shared-types/drizzle";
import { log } from "../share";
import { RequestError } from "./error";
import type { EndpointCtx } from "./types";

export class IniviteManager {
	private inviteLinkEnabled: boolean;
	private request: Request;
	constructor(
		private env: Env,
		private Project: Project,
		private ctx: EndpointCtx,
	) {
		this.inviteLinkEnabled = Project.registerOnInvite;
		this.request = ctx.req.raw;
	}

	handleRegister(id: string | null): Promise<void> {
		if (!this.inviteLinkEnabled) return Promise.resolve();
		if (!id) throw this.createError("Invite link ID is required", 400);
		return this.ensureInviteLinkIsValid(id).catch((err) => {
			log(
				`Error validating invite link for invite_id: ${id}, error: ${
					(err as Error).message
				}`,
			);
			setCookie(this.ctx, COOKIE_INVITE_ID, "", {
				expires: new Date(),
			});
			if (err instanceof RequestError) {
				throw err;
			}
			throw this.createError("Invalid invite link", 400);
		});
	}

	async removeInviteLinkById(id: string): Promise<void> {
		if (!this.inviteLinkEnabled) return Promise.resolve();
		try {
			await drizzle(this.env.AUTH_DB)
				.delete(WebUiInviteLinkTable)
				.where(eq(WebUiInviteLinkTable.id, id))
				.run();
		} catch (err) {
			log(
				`Error removing invite link with id: ${id}, error: ${(err as Error).message}`,
			);
			insertLog({
				type: "warning",
				message: `Error removing invite link with id: ${id}, error: ${(err as Error).message}`,
				clientID: this.Project.clientID,
				database: this.env.AUTH_DB,
				endpoint: "getOrCreateUser in invite flow",
			});
		}
	}

	async ensureInviteLinkIsValid(id: string): Promise<void> {
		const inviteLink = await drizzle(this.env.AUTH_DB)
			.select({
				expiresAt: WebUiInviteLinkTable.expiresAt,
			})
			.from(WebUiInviteLinkTable)
			.where(eq(WebUiInviteLinkTable.id, id))
			.get();

		if (!inviteLink) {
			throw new RequestError({
				message: "Invite link not found",
				status: 404,
				endpoint: "/invite/register",
				params: this.ctx.get("params"),
				project: this.Project,
				log: true,
				request: this.request,
			});
		}
		if (
			inviteLink.expiresAt &&
			new Date(inviteLink.expiresAt).getTime() < Date.now()
		) {
			await this.removeInviteLinkById(id);
			throw this.createError("Invite link has expired", 400);
		}
	}
	private createError(message: string, status: ContentfulStatusCode = 400) {
		return new RequestError({
			message,
			status,
			endpoint: "/invite/register",
			params: this.ctx.get("params"),
			project: this.Project,
			log: true,
			request: this.request,
		});
	}
}
