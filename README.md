# OpenAuthster Issuer

> 🔐 Multi-tenant authentication server built on [OpenAuth](https://openauth.js.org/) for Cloudflare Workers

## Overview

OpenAuthster Issuer is the core authentication server that powers the OpenAuthster ecosystem. It provides:

- 🏢 **Multi-Tenant Architecture** - Host multiple projects on a single deployment
- ⚡ **Edge Deployment** - Runs on Cloudflare Workers for global low-latency
- 🗄️ **D1 Database** - Serverless SQL database for user and session storage
- 📧 **Email Authentication** - Built-in email/password and magic link support
- 🔗 **OAuth Providers** - Configurable social login providers (Google, GitHub, etc.)
- 🎨 **Themeable** - Customizable authentication UI per project

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) - Cloudflare's command-line tool
- [Bun.js](https://bun.sh) (recommended) or Node.js
- Cloudflare account with Workers and D1 access

```bash
# Install Wrangler globally
bun add -g wrangler

# Or with npm
npm install -g wrangler
```

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/shpaw415/OpenAuthSter-issuer.git
cd OpenAuthSter-issuer
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Rename wrangler.example.json and run the types

Rename or create `wrangler.example.json` > `wrangler.json`.
Run `wrangler types`

### 4. Create D1 Database

Create a new D1 database in your Cloudflare dashboard or via CLI:

```bash
wrangler d1 create openauth-db
```

### 5. Configure Wrangler

Update your `wrangler.json` with the database credentials:

```json
{
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "<your-database-name>",
      "database_id": "<your-database-id>"
    }
  ]
}
```

> 💡 Copy the `database_name` and `database_id` from the output of the `wrangler d1 create` command

### 6. Run Database Migrations

Apply the database schema to your D1 database:

```bash
wrangler d1 migrations apply AUTH_DB --remote
```

### 7. Configure OpenAuth

Edit `openauth.config.ts` to set up your authentication settings:

> register strategy provider: only `custom` and `resend` are supported for now, but keep track some out of the box will come shortly.

```typescript
// openauth.config.ts
export default async (env: Env) =>
  createExternalGlobalProjectConfig({
    register: {
      fallbackEmailFrom: "fallback@example.com",
      strategy: {
        email: {
          provider: "custom", // "custom" | "resend"
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
  }),
});
```

### 8. Deploy

create a new private repo on your github dashboard.
this way you can manage versioning direclty from git.

```bash
git remote add cloudflare https://github.com/my-username/my-private-auth-issuer.git
git add .
git commit -m "setup"
git push --set-upstream cloudflare
```

go to your Cloudflare dashboard and create a new worker and link it with your newly created Repo.

## Development

Run the issuer locally for development:

```bash
wrangler dev --port 8788
```

The server will be available at `http://localhost:8788`

## Project Structure

```
openauth-multitenant-server/
├── src/
│   ├── index.ts           # Worker entry point
│   ├── providers-setup.ts # OAuth provider configuration
│   ├── share.ts           # Shared utilities
│   ├── client/            # Client-side utilities
│   ├── db/                # Database schema and adapters
│   ├── defaults/          # Default themes and email templates
│   └── endpoints/         # API endpoints
├── drizzle/               # Database migrations
├── openauth.config.ts     # OpenAuth configuration
└── wrangler.json          # Cloudflare Worker configuration
```

## Next Steps

After deploying the issuer, set up the WebUI to manage your projects:

👉 [OpenAuthster WebUI](https://github.com/shpaw415/OpenAuthSter-webUI)

## Related Repositories

- [OpenAuthster](https://github.com/shpaw415/openauthster) - Main project documentation
- [OpenAuthster WebUI](https://github.com/shpaw415/OpenAuthSter-webUI) - Management dashboard
- [Shared Types](https://github.com/shpaw415/OpenAuthSter-shared) - TypeScript types and client SDK
- [React SDK](https://github.com/shpaw415/openauth-react) - React integration (WIP)

## License

> License information coming soon
