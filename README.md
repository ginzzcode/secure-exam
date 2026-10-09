# Secure Exam Portal

Frontend foundation for the Secure Exam Portal. This repository currently contains
Milestone M1 only: a working project shell with no product features. The approved
specification lives in `docs/` and is the source of truth.

## Scope of M1

In scope: a React + Vite + JSX shell, environment configuration, a bundle secret
scan, a Supabase CLI config with an empty migrations directory, a CI skeleton, and
Vercel preparation.

Out of scope (M2 and later): database schema and RLS, authentication and
provisioning, Edge Functions, login or role guards, exam and session logic, PWA or
service worker, reports, exports, and activity tracking.

## Prerequisites

- Node.js 20.19 or newer (CI uses Node 24)
- npm

## Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies (first checkout) |
| `npm ci` | Reproducible install from `package-lock.json` (CI) |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run ESLint |
| `npm run scan:bundle` | Scan `dist/` for privileged secrets |
| `npm test` | Placeholder test job (no product tests exist in M1) |

## Environment variables

The frontend reads two variables, both from `.env.local` locally. Copy the
template and fill in the values:

```
copy .env.example .env.local
```

- `VITE_SUPABASE_URL` - the Supabase project URL
- `VITE_SUPABASE_ANON_KEY` - the publishable (anon) key

Only these two values may reach the browser. The service-role key, secret keys,
and any privileged backend credential must never be placed in a `VITE_` variable.
Vite inlines every `VITE_` variable into the bundle.

### Environment matrix

| Environment | Supabase project | Frontend |
| --- | --- | --- |
| Local development | local Supabase stack (`npx supabase start`) | `npm run dev` on `localhost` |
| Staging | Supabase staging project, region Singapore | Vercel preview or a staging deployment |
| Production | Supabase production project, region Singapore | Vercel production deployment |

Use separate Supabase projects and separate keys per environment. Refer to
`docs/ARCHITECTURE.md` section 10 for the approved environment model.

Placeholders in this repository are inert strings only. No real project URL, anon
key, access token, or service key is committed. Do not create fake production
credentials.

## Bundle secret scan

`npm run scan:bundle` (and the same step in CI) scans the generated `dist/` output
and fails when a recognized privileged secret pattern is present. It detects:

1. JSON Web Tokens whose decoded payload carries a privileged role
   (`service_role`, `supabase_admin`, `supabase_auth_admin`,
   `supabase_storage_admin`). `anon` and `authenticated` tokens are allowed.
2. Supabase secret API keys with the `sb_secret_` prefix.
3. PEM-encoded private keys (RSA, EC, PKCS8, OPENSSH).
4. Any `VITE_` variable name containing `SERVICE`, `SECRET`, or `PRIVATE`.
5. Literal service-key variable names such as `SUPABASE_SERVICE_ROLE_KEY`.

Limitations: this is a best-effort string and token scan, not a proof of safety. It
cannot detect obfuscated, split, encoded, or dynamically constructed secrets,
secrets fetched at runtime, or unknown secret formats. A passing scan means none of
the recognized patterns were found; it does not prove the bundle is secret-free.
Keep the scan paired with review and least privilege.

## Supabase CLI

The CLI is a dev dependency, so commands run through `npx supabase`. Configuration
is in `supabase/config.toml`. Migrations live in `supabase/migrations/`, which is
intentionally empty in M1.

| Command | Purpose |
| --- | --- |
| `npx supabase start` | Start the local development stack |
| `npx supabase stop` | Stop the local stack |
| `npx supabase migration list --linked` | Compare local and remote migration state |
| `npx supabase migration new <name>` | Create an empty migration file |
| `npx supabase db push --linked --dry-run` | Preview applying migrations to a linked project |

Do not commit access tokens. Link a hosted project with credentials you supply
locally (`npx supabase login`, then `npx supabase link`). No tables, policies,
functions, seed data, or Edge Functions are created in M1.

### Project provisioning limitation

The initial Supabase plan is Free. Free-tier project-count and capability limits
have not been verified against the school's account. Whether staging and production
can both be provisioned on Free is therefore unresolved. Provisioning hosted
projects requires dashboard or CLI access with credentials and is a manual step;
it is not performed by this repository. If the Free plan cannot host both
environments, that is a decision point for the school, not an assumption to make here.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`:

- install with `npm ci` (uses `package-lock.json`)
- `npm run lint`
- `npm run build`
- `npm run scan:bundle`
- a clearly labeled placeholder test job

The workflow uses `contents: read` permissions. It is configured but has not been
executed here because no remote repository or CI runner is connected.

## Vercel

`vercel.json` sets the Vite framework, build command, output directory, and an SPA
rewrite. Required environment variables are the same two from `.env.example`; set
them per Vercel environment (preview and production). Do not put privileged
credentials in Vercel client configuration.

Deployment is manual and requires explicit authorization. This repository does not
connect a remote, create Vercel resources, or deploy automatically.

## Documentation

The approved specification documents are in `docs/`:

- `PROJECT_SPEC.md`
- `ARCHITECTURE.md`
- `DATABASE_DESIGN.md`
- `ACCESS_CONTROL.md`
- `THREAT_MODEL.md`
- `RELIABILITY_AND_SCALE.md`
- `IMPLEMENTATION_PLAN.md`
