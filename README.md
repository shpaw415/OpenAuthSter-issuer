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

Clone as a **private repository** (recommended for production):

```bash
git clone https://github.com/shpaw415/OpenAuthSter-issuer.git openauth-issuer
cd openauth-issuer
```

> ⚠️ **Security Note:** Keep your issuer repository private as it contains sensitive authentication configuration and secrets.

### 2. Install Dependencies

```bash
bun install
```

### 3. Configure Wrangler

Rename `wrangler.example.json` to `wrangler.json`:

```bash
mv wrangler.example.json wrangler.json
```

Then run the types generation:

```bash
wrangler types
```

Update `wrangler.json` with the database credentials from step 4.

### 4. Create D1 Database

Create a new D1 database in your Cloudflare dashboard or via CLI:

```bash
wrangler d1 create openauth-db
```

### 5. Configure Wrangler

Update your `wrangler.json` with the database credentials and environment variables:

```json
{
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "<your-database-name>",
      "database_id": "<your-database-id>",
      "migrations_dir": "drizzle/migrations",
      "remote": true
    }
  ],
  "vars": {
    "WEBUI_ADMIN_EMAILS": "admin@example.com,owner@example.com",
    "WEBUI_ORIGIN_URL": "https://admin.yourdomain.com",
    "ISSUER_URL": "https://auth.yourdomain.com"
  }
}
```

**Configuration Details:**

| Variable             | Description                                                   | Example                                |
| -------------------- | ------------------------------------------------------------- | -------------------------------------- |
| `database_name`      | D1 database name from step 4                                  | `openauth-db`                          |
| `database_id`        | D1 database ID from step 4                                    | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `WEBUI_ADMIN_EMAILS` | Comma-separated list of admin emails who can access the WebUI | `admin@example.com,owner@example.com`  |
| `WEBUI_ORIGIN_URL`   | Your WebUI domain (deployed in next steps)                    | `https://admin.yourdomain.com`         |
| `ISSUER_URL`         | Your issuer domain (this deployment)                          | `https://auth.yourdomain.com`          |

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
    data: any(),
    clientID: string(),
    provider: string(),
  }),
});
```

### 8. Deploy

Deploy to Cloudflare Workers:

1. **Create a private GitHub repository** and push your code:

   ```bash
   # Create a new private repository on GitHub
   # Then set it as your remote:
   git remote set-url origin https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO.git
   git add .
   git commit -m "Initial setup"
   git push -u origin main
   ```

2. **Create a Cloudflare Worker:**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages
   - Click "Create application" → "Create Worker"
   - Connect to your private GitHub repository
   - Cloudflare will automatically detect the `wrangler.json` configuration

3. **Configure environment variables** (if needed) in the Cloudflare dashboard

4. **Deploy!**

## Development

Run the issuer locally for development:

```bash
wrangler dev --port 8788
```

The server will be available at `http://localhost:8788`

## API Endpoints

The issuer exposes several REST API endpoints for user and session management:

### User Management (Admin)

Requires authentication with client secret via `X-Client-Secret` header.

- **GET** `/user/:clientID/:userID` - Get user details by ID
- **PUT** `/user/:clientID/:userID` - Update user (identifier and session data)
- **DELETE** `/user/:clientID/:userID` - Delete user by ID
- **GET** `/users/:clientID?page=1&limit=10` - List users with pagination

### Session Management

Requires authentication with Bearer token via `Authorization` header.

**Public Session** (accessible from browser):

- **GET** `/session/public/:clientID` - Get public session data
- **PATCH** `/session/public/:clientID` - Update public session data
- **DELETE** `/session/public/:clientID` - Clear public session data

**Private Session** (server-side only, requires secret):

- **GET** `/session/private/:clientID` - Get private session data
- **PATCH** `/session/private/:clientID` - Update private session data
- **DELETE** `/session/private/:clientID` - Clear private session data

### Utility Endpoints

- **GET** `/health` - Health check
- **GET** `/version` - Get OpenAuthster issuer version
- **GET** `/cleanup` - Clear authentication cookies (testing)

### Authentication Endpoints

All OpenAuth standard endpoints are available at `/*` for OAuth flows.

## Project Structure

```
openauth-multitenant-server/  # (GitHub: OpenAuthSter-issuer)
├── src/
│   ├── index.ts              # Worker entry point
│   ├── providers-setup.ts    # OAuth provider configuration
│   ├── share.ts              # Shared utilities
│   ├── client/               # Client-side utilities
│   ├── db/                   # Database schema and adapters
│   ├── defaults/             # Default themes and email templates
│   └── endpoints/
│       └── index.ts          # API endpoints (Hono-based)
├── drizzle/                  # Database migrations
├── openauth.config.ts        # OpenAuth configuration
└── wrangler.json             # Cloudflare Worker configuration
```

## Next Steps

After deploying the issuer, set up the WebUI to manage your projects:

👉 [OpenAuthster WebUI](https://github.com/shpaw415/OpenAuthSter-webUI)

## Related Repositories

- [OpenAuthster](https://github.com/shpaw415/openauthster) – Main project documentation
- [OpenAuthster WebUI](https://github.com/shpaw415/OpenAuthSter-webUI) – Management dashboard
- [Shared Types](https://github.com/shpaw415/OpenAuthSter-shared) – TypeScript types and client SDK
- [React SDK](https://github.com/shpaw415/openauth-react) – React integration (WIP)
- [Testing Environment](https://github.com/shpaw415/openauthster-tester) – Pre-configured testing setup

## License

> License information coming soon
