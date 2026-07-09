# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install     # install dependencies
npm start       # run shopify-server.js on PORT (default 3001)
```

There is no build step, lint config, or test suite in this repo — `start` is the only defined script. The frontends (`public/template-designer.html`, `public/customer-form.html`) are plain HTML/CSS/vanilla JS with no bundler; edit them directly and reload the browser.

## Folder layout

```
shopify-server.js        Express entry point (root, per package.json "main")
public/                  Static HTML served directly (template designer, customer form)
data/                    Local "database" — templates.json + sample/demo PDFs
legacy/                  Old standalone prototype, still mounted at "/"
scripts/                 One-off dev scripts, not run by the server
```

`shopify-server.js` only serves `public/` via `express.static` (not the whole repo root) — don't add files that need direct static serving anywhere else.

Local dev URLs (after `npm start`):
- Template Designer: `http://localhost:3001/designer`
- Customer Form: `http://localhost:3001/form?id=TEMPLATE_ID`

On every start, the server also auto-launches a `localtunnel` (see `startTunnel()` in `shopify-server.js`) so the app is reachable at a public URL for Shopify to proxy to during local development. It auto-restarts on tunnel close/error.

## Architecture

This is a single-process Express app (`shopify-server.js`) that is simultaneously:
1. A **Shopify embedded admin app** (Template Designer, at `/designer` and `/designer/embedded`)
2. A **Shopify App Proxy target** serving a customer-facing form on the storefront domain
3. A thin **Shopify Admin API client** for uploading signed PDFs and attaching them to orders

Everything — routing, template CRUD, Shopify GraphQL calls, OAuth — lives in the one server file; there is no MVC layering or separate route/controller modules.

### Request paths and why they're duplicated

Every customer-facing API/page route exists in two forms:
- Direct: `/form`, `/api/templates/:id`, `/api/save-signed-pdf`
- Proxied: `/proxy/form`, `/proxy/api/templates/:id`, `/proxy/api/save-signed-pdf`

The `/proxy/*` routes exist because Shopify's App Proxy rewrites `{store}.myshopify.com/apps/pdf-signer/*` to `{app}/proxy/*` and signs the request with a `signature` query param (verified by `verifyProxySignature`). The direct routes remain for standalone testing without going through Shopify at all. `public/customer-form.html` detects which mode it's in at load time by checking `location.pathname` for the `/apps/pdf-signer/` prefix and switches its `apiBase` accordingly — when editing API calls in that file, both code paths need to stay in sync.

Similarly, `/designer/embedded` is HMAC-verified (`verifyShopifyHmac`, for requests coming from Shopify Admin's iframe) while plain `/designer` is not (standalone access).

### Auth model — two mutually exclusive modes

`shopify-server.js` picks one of two auth strategies at startup based on env vars (see the `needsOAuth` check):
- **Static Admin API token** (`SHOPIFY_ADMIN_API_TOKEN` set, not prefixed `shpss_`) — simplest, used for a single fixed dev store, no session state needed.
- **OAuth** (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` set, no usable static token) — registers `/auth` and `/auth/callback`, stores the resulting access token in the Express session (`express-session`, in-memory by default).

`getShopifyToken()` / `shopifyGraphQL()` prefer the session token over the env token when both could apply. Any new Shopify API call must go through `shopifyGraphQL(query, variables, req)` so it picks up whichever auth mode is active — don't call `fetch` against the Admin API directly.

### Template storage

Templates (PDF + field layout + metadata) are stored as a flat array in `data/templates.json`, read/written wholesale via `loadTemplates()` / `saveTemplates()` — no database, no migrations, no partial updates. Each template embeds the full source PDF as base64 (`pdfBase64`), so this file grows large; treat it as dev-only storage (the README already calls out that production should swap this for a real DB).

### PDF handling — client-side, not server-side

The server never rasterizes or edits PDFs. All rendering (`pdf.js`) and field-writing (`pdf-lib`) happens in the browser, loaded from CDN in `public/template-designer.html` and `public/customer-form.html` (not npm dependencies — check those `<script src>` tags if bumping versions). The server's only PDF-related job is accepting a final signed PDF as base64 and forwarding the bytes to Shopify's staged-upload flow (`uploadPdfToShopify` in `shopify-server.js`): `stagedUploadsCreate` → multipart POST to the staged URL → `fileCreate` to register it and get a permanent URL. Optionally that URL is then written onto an order via `attachFileToOrder` (a `metafieldsSet` mutation, namespace `custom`, key `signed_pdf_url`).

### Deployment targets

Three deploy configs are checked in and kept in sync manually (no shared config source): `render.yaml` (Render blueprint), `fly.toml` + `Dockerfile` (Fly.io), and `Procfile` (Heroku-style). All three ultimately just run `npm start`; differences are only in how env vars/secrets are supplied. `.env.example` is the canonical list of required env vars.

### One-off scripts (`scripts/`)

`scripts/make_pdf.js`, `scripts/query_page.js`, `scripts/update_page.js`, `scripts/update_page2.js`, and `scripts/tunnel.bat` are throwaway dev scripts for manipulating the dev store directly (generating a demo PDF into `data/demo.pdf`, reading/writing a Shopify Page's `body_html` to embed the form iframe) — they are not imported by the server and aren't part of the running app. They load `SHOPIFY_STORE`/`SHOPIFY_ADMIN_API_TOKEN` from the root `.env` via `dotenv` — never hardcode a token back into these files, since (unlike `.env`) they're tracked by git. `update_page.js` and `update_page2.js` are two historical variants of the same one-off task (different tunnel URLs); nothing currently depends on either running again.
