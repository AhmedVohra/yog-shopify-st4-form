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
sharepoint.js            Microsoft Graph client — uploads signed PDFs to SharePoint
email.js                 Microsoft Graph client — emails a copy of the signed PDF to the customer
graphAuth.js             Shared Graph client-credentials token fetch, used by both of the above
public/                  Static HTML served directly (template designer, customer form)
data/                    Local "database" — templates.json + sample/demo PDFs
shopify.app.toml         Shopify CLI app config (client_id, App Proxy, OAuth, scopes)
legacy/                  Old standalone prototype — dead code, kept but unreferenced
scripts/                 One-off dev scripts, not run by the server
```

`shopify-server.js` only serves `public/` via `express.static` (not the whole repo root) — don't add files that need direct static serving anywhere else.

`legacy/pdf-signer.html` is **not** mounted anywhere anymore (the root `/` route used to serve it, but it isn't part of any deploy zip — see Deployment below — so pointing a route at it crashes with `ENOENT`). `/` now just redirects to `/designer`. Treat `legacy/` as inert; nothing imports it.

Local dev URLs (after `npm start`):
- Template Designer: `http://localhost:3001/designer`
- Customer Form: `http://localhost:3001/form?id=TEMPLATE_ID`

On every start, the server also auto-launches a `localtunnel` (see `startTunnel()` in `shopify-server.js`) so the app is reachable at a public URL for Shopify to proxy to during local development. It auto-restarts on tunnel close/error.

## Architecture

This is a single-process Express app (`shopify-server.js`) that is simultaneously:
1. A **Shopify embedded admin app** (Template Designer, at `/designer` and `/designer/embedded`)
2. A **Shopify App Proxy target** serving a customer-facing form on the storefront domain
3. A **SharePoint uploader** (`sharepoint.js`) — signed PDFs are stored in a SharePoint document library via Microsoft Graph (client-credentials), NOT in Shopify Files (that flow was removed; only dormant dev utilities still use the Admin API)
4. An **email sender** (`email.js`) — optionally emails the customer a copy of their signed PDF via Microsoft Graph `sendMail`, using a *separate* Entra app/tenant from SharePoint's (see "Two Graph credential sets" below)

Everything — routing, template CRUD, Shopify GraphQL calls, OAuth — lives in the one server file; there is no MVC layering or separate route/controller modules.

The Shopify app itself ("PDF Signer & Form Builder", client_id `8f86ace9…`) is created and managed through **Shopify CLI** (`@shopify/cli`, a devDependency — not installed globally), not the classic Partner Dashboard UI. `shopify.app.toml` is the real, deployed source of truth for its config (App Proxy, OAuth redirect URLs, webhooks, scopes) — edit it and run `shopify app deploy --client-id=8f86ace95ee2d1c674d2786ea7fdb78f --allow-updates` to push changes; don't reconfigure things by hand in the Dev Dashboard (`dev.shopify.com`, the newer surface this app lives in — not `partners.shopify.com`) or they'll drift from the file. See "Shopify CLI" below for schema and non-interactivity gotchas.

### Request paths and why they're duplicated

Every customer-facing API/page route exists in two forms:
- Direct: `/form`, `/api/templates/:id`, `/api/save-signed-pdf`
- Proxied: `/proxy/form`, `/proxy/api/templates/:id`, `/proxy/api/save-signed-pdf`

The `/proxy/*` routes exist because Shopify's App Proxy rewrites `{store}.myshopify.com/apps/pdf-signer/*` to `{app}/proxy/*` and signs the request with a `signature` query param (verified by `verifyProxySignature`; set `REQUIRE_PROXY_SIGNATURE=1` in production to reject unsigned requests). The direct routes remain for standalone testing without going through Shopify at all. `public/customer-form.html` detects which mode it's in at load time by checking `location.pathname` for the `/apps/pdf-signer/` prefix and switches its `apiBase` accordingly — when editing API calls in that file, both code paths need to stay in sync.

**`/proxy/form` serves a Liquid fragment, not the raw HTML file.** `buildLiquidFragment()` in `shopify-server.js` extracts the `<style>` and `<body>` content of `customer-form.html`, re-scopes the `body {` CSS rule to `#pdfSignerRoot`, and returns it with `Content-Type: application/liquid` so Shopify renders the form inside the store theme (header/footer, no iframe). Two constraints follow: `customer-form.html` must never contain literal `{{` or `{%` sequences (Liquid would parse them and silently break the proxied page — JS template literals `${...}` are fine), and its single `body {` style rule must stay on its own line so the selector rewrite keeps matching.

Similarly, `/designer/embedded` is HMAC-verified (`verifyShopifyHmac`, for requests coming from Shopify Admin's iframe) while plain `/designer` is not (standalone access). `shopify.app.toml`'s `application_url` points at `/designer/embedded` — that's the page Shopify Admin actually loads when a merchant opens the app, so it must always resolve to something real (it silently broke once already by pointing at the bare root, which was resolving to the dead `legacy/` file — see Folder layout above).

**HMAC message-joining gotcha — do not "simplify" this.** There are *two different, both-correct* HMAC algorithms in this file and they are easy to conflate:
- `verifyProxySignature` (App Proxy `signature` param): sorted `key=value` pairs, **percent-encode `%`→`%25` and `=`→`%3D` in both key and value**, then join with **no separator**.
- `verifyShopifyHmac` and the `/auth/callback` handler (Admin iframe load / OAuth `hmac` param): sorted `key=value` pairs, **no percent-encoding**, joined with **`&`**.

Both previously used the no-separator form for the Admin/OAuth case, which is wrong — Shopify's Admin/OAuth HMAC always uses `&`. That bug shipped silently for a long time because `/designer/embedded` was never actually hit by real Shopify traffic until `application_url` got fixed to point at it. If you touch either verification function, do not copy the other's algorithm in.

### Auth model — two mutually exclusive modes

`shopify-server.js` picks one of two auth strategies at startup based on env vars (see the `needsOAuth` check):
- **Static Admin API token** (`SHOPIFY_ADMIN_API_TOKEN` set, not prefixed `shpss_`) — simplest, used for a single fixed dev store, no session state needed.
- **OAuth** (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` set, no usable static token) — registers `/auth` and `/auth/callback`, stores the resulting access token in the Express session (`express-session`, in-memory by default).

`getShopifyToken()` / `shopifyGraphQL()` prefer the session token over the env token when both could apply. Any new Shopify API call must go through `shopifyGraphQL(query, variables, req)` so it picks up whichever auth mode is active — don't call `fetch` against the Admin API directly.

### Template storage

Templates (PDF + field layout + metadata) are stored as a flat array in `data/templates.json`, read/written wholesale via `loadTemplates()` / `saveTemplates()` — no database, no migrations, no partial updates. Each template embeds the full source PDF as base64 (`pdfBase64`), so this file grows large; treat it as dev-only storage (the README already calls out that production should swap this for a real DB). `saveTemplates()` wraps its write in a try/catch and the template POST/PUT/DELETE routes return 503 if it fails, so a deployment target with a read-only filesystem degrades cleanly instead of crashing — not currently hit on the App Service target (its filesystem is writable), but relevant if that ever changes.

### PDF handling — client-side, not server-side

The server never rasterizes or edits PDFs. All rendering (`pdf.js`) and field-writing (`pdf-lib`) happens in the browser, loaded from CDN in `public/template-designer.html` and `public/customer-form.html` (not npm dependencies — check those `<script src>` tags if bumping versions). The server's only PDF-related job is accepting a final signed PDF as base64 (`handleSaveSignedPdf` in `shopify-server.js`) and uploading the bytes to a SharePoint document library via `uploadPdfToSharePoint` in `sharepoint.js` (Microsoft Graph client-credentials flow: token from `login.microsoftonline.com`, lazy site/drive resolution, then a simple `PUT …:/content` — fine because signed PDFs are well under Graph's 4 MB simple-upload limit). Stored filenames get a timestamp prefix because Graph PUT silently overwrites same-name files.

`sharepoint.js`'s drive resolution is IDs-first: if `SHAREPOINT_DRIVE_ID` is set, it's used directly against Graph's `/drives/{id}/root:/...` endpoint with **no site lookup at all** — a drive ID is self-sufficient. Site-based resolution (`SHAREPOINT_HOSTNAME` + `SHAREPOINT_SITE_PATH` → site → drive by `SHAREPOINT_LIBRARY` name) is only a fallback for when no drive ID is configured. Don't reintroduce a hard dependency on site resolution when a drive ID is present — that was a real bug once (see git history).

### Two Graph credential sets — SharePoint (merchant) vs. email (vendor by default)

`graphAuth.js`'s `getGraphToken(credentials)` takes the credential set explicitly (`{tenantId, clientId, clientSecret, label}`) rather than reading fixed env var names, and caches one token per `clientId` — because `sharepoint.js` and `email.js` intentionally use **different** Entra app registrations, often in different tenants:

- `sharepoint.js` always uses `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` — the **merchant's own tenant**, since that's where their SharePoint document library actually lives. This can't be swapped for a shared tenant.
- `email.js` uses `MAIL_TENANT_ID`/`MAIL_CLIENT_ID`/`MAIL_CLIENT_SECRET`/`MAIL_FROM` — independent of the above, and by default pointed at **our own (vendor) tenant and mailbox**. This app is sold to multiple merchants, and each one granting `Mail.Send` (application permission, admin consent) in their own tenant is a setup step that would otherwise block onboarding/testing. Sending from our own mailbox means every deployment can email customers immediately with zero merchant setup. A given deployment can later be switched to send as the merchant's own domain by repointing those same four env vars at their tenant + a mailbox they grant us `Mail.Send` on — nothing else in `email.js` changes either way.

`MAIL_FROM` must be a real, **licensed** Exchange Online mailbox (Microsoft 365 Business Basic or higher) — an unlicensed `.onmicrosoft.com` account with no mail plan attached fails with `MailboxNotEnabledForRESTAPI` even with a valid token and `Mail.Send` consented. Microsoft's free Developer Program sandbox is tempting as a source of a "free" mailbox for this but was deliberately avoided: it's explicitly ToS-restricted to dev/test use, and its tenant can be rotated out from under a real deployment — not a foundation for a production sending address. A plain SMTP-based sender (e.g. via `nodemailer`) was tried as an alternative to sidestep the Graph/licensing requirements entirely and works with any provider (Zoho, Gmail Workspace, etc.) with zero app-registration dance, but was reverted in favor of Graph once a real licensed mailbox was available — Graph is Microsoft's officially supported path and avoids relying on legacy SMTP AUTH, which Microsoft now disables by default on new Exchange Online tenants.

If you add a third Graph-backed feature, follow the same pattern: build its own `{tenantId, clientId, clientSecret, label}` object from whatever env vars make sense for that feature's trust boundary, don't assume it should reuse `MS_*` or `MAIL_*`.

### Template Designer — zoom and the field coordinate system

Field `x`/`y`/`w`/`h` in `data/templates.json` are stored in a fixed coordinate space — canvas pixels at a **1.5 pdf.js render scale** (the `STORAGE_SCALE` constant in `template-designer.html`). This must match `customer-form.html`, which always renders at a hardcoded 1.5 scale with no zoom of its own; the two files silently agree on this and neither declares it anywhere obvious except the `STORAGE_SCALE` constant and the `canvasScale = 1.5` in `customer-form.html`'s `buildFilledPdfBytes()`.

The Designer has variable zoom (50%–300%, toolbar +/−/Reset), which means its own on-screen rendering scale is *not* the storage scale. `toStorage(px)` / `toDisplay(px)` convert between the two — every place that reads a mouse coordinate to create/move/resize a field must run it through `toStorage()` before writing to `fields[]`, and every place that positions an overlay div from stored data must run it through `toDisplay()`. If you add a new interaction that touches field geometry, get this conversion right or templates will render correctly at one zoom level and wrong at every other one (and wrong on the customer form, which has no zoom to hide the mismatch).

Resize has three modes (`resizeMode`: `null` | `'br'` | `'top'`), each with a type-aware minimum size via `getMinFieldSize(type)` — checkboxes floor at 10px, everything else at 60×24 (sized for text fields; don't apply the text floor to new small field types without checking this function first). The top-handle resize keeps the *bottom* edge fixed while dragging the top edge, so a field can be shrunk down and away from a printed label above it without also needing to reposition.

The `.pdf-area` (Designer) / `.pdf-panel` (customer form) containers use `align-items: safe center; justify-content: safe center;` (CSS Alignment Level 3), not plain `center` — plain `center` on a scrollable flex container clips the leading (top/left) overflow from scroll reach once content is bigger than the viewport, which made zoomed-in content above the fold permanently unreachable. Don't revert to plain `center` on either of these.

### Customer form — field visibility and download

`.field-input` (the overlay boxes positioned on the PDF) are **transparent by default and only show a border on `:focus`** — the form is meant to look like the underlying paper form until a customer clicks into a field, not a page full of blue boxes. Two exceptions stay visible unconditionally: `.field-input.required` (a persistent red border, since customers should be able to see what's mandatory without clicking through every field) and `.field-input.signature` (it's click-to-open-signature-pad, not type-in-place, so it has no focus state to reveal it otherwise). All of these rules use `!important` — this form is injected into an arbitrary merchant theme's page via the App Proxy Liquid fragment, and theme CSS can otherwise override plain-specificity rules.

`buildFilledPdfBytes()` is shared by `submitForm()` (uploads to SharePoint) and `downloadPdf()` (local browser download via `Blob` + a temporary `<a download>`) — the field-drawing logic lives in exactly one place. When drawing text, `page.drawText()`'s `y` is the **baseline**, not the box top or bottom; it's positioned at `(box bottom) + fontSize * 0.2`, a small positive offset so filled text sits just above the box's bottom edge (where the printed line typically is) instead of below it. Get the sign wrong here and every filled value renders below/through the printed line instead of on top of it.

`customer-form.html` reads an optional `?email=` query param (`customerEmail`) at load and, if present, includes it in the `save-signed-pdf` POST body — this is how a copy of the signed PDF gets emailed to the customer server-side (see `email.js` above); it's meant to be carried over from an upstream signup/application form that already collected the customer's email, not typed in on the ST-4 form itself. After a successful submit in App Proxy mode (`apiBase` starting with `/apps/`), the form redirects back to `/pages/pending-approval` on the storefront after a short delay; standalone/direct mode never redirects, since there's no store page to land on there.

### Deployment targets

The production target is an **Azure App Service Web App** (Linux, Node 22, F1 free tier, resource group `st4-pdf-signer-rg`, app `yog-st4-form` — `https://yog-st4-form.azurewebsites.net`) running the Express server directly via `npm start`; no custom handler layer. This was chosen over an Azure Functions custom handler after hitting a platform-level bug: Node custom handlers on Windows Consumption Function Apps intermittently fail to bind ("access to socket forbidden by its access permissions") — a known, documented Azure limitation, not a bug in this app. The server listens on `process.env.PORT` (App Service sets it) bound to all interfaces — **do not** bind only to `127.0.0.1`, since Azure's warmup/health probe reaches the container over its external interface, not loopback. `IN_AZURE` is detected via `WEBSITE_HOSTNAME` and skips the localtunnel there.

**Deploying:**
```bash
az webapp deploy --name yog-st4-form --resource-group st4-pdf-signer-rg --src-path <zip> --type zip
```
The zip must be **source-only, no `node_modules`** — `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (already set as an app setting) makes Oryx run `npm install` server-side. When building the zip on Windows, **PowerShell's `Compress-Archive` writes backslash path separators inside the zip** (`server\function.json` instead of `server/function.json`), which breaks anything that parses directory structure from the archive — use Python's `zipfile` module instead (always emits forward slashes), excluding `.git`, `node_modules`, `scripts`, `legacy`, `.env`, and `*.md`.

**Before every deploy, sync `data/templates.json` from the live app first** (`GET /api/templates/:id` for each template, overwrite the local file) and diff it against local — the deploy zip includes whatever's in that file, and the App Service filesystem is writable, so merchants can (and do) edit templates live through the Designer between deploys. Deploying a stale local copy silently overwrites their work. There is no template storage outside this one JSON file.

### Shopify CLI

`shopify app config link` and `shopify app deploy`'s interactive prompts (organization/app selection, config file naming) need a real TTY and fail even through this environment's `!`-prefixed "run it yourself" pathway — there's no way to satisfy them non-interactively, and `winpty`/similar TTY-emulation tools don't help either (no underlying console handle to attach to). Workaround: create/link the app via the Dev Dashboard web UI to get a `client_id`, hand-edit `shopify.app.toml` (validate with `shopify app config validate --client-id=...`), then `shopify app deploy --client-id=... --allow-updates` — both flags avoid the interactive path entirely.

`shopify.app.toml` schema notes (the field names are stricter than they look): top-level `embedded` must be a **boolean**, not a `[embedded]` table with sub-keys; `[auth]` needs `redirect_urls` (an array, not `redirect_url`); `[webhooks]` needs `api_version` even if no webhooks are configured; `[app_proxy]` needs `url` + `subpath` + `prefix` (not `path_prefix`). `shopify app config validate` catches all of this before you waste a deploy on it.

New Dev-Dashboard apps (as opposed to classic Partner Dashboard apps) need a **Distribution method** set once, from the Dev Dashboard UI, before *any* install works — otherwise Shopify refuses with "This app can't be installed yet," and there's no CLI command for it. For a single-merchant app, "Custom distribution" is right; it then hands you a signed install link (`admin.shopify.com/store/{store}/oauth/install_custom_app?client_id=...&signature=...`) — use that exact link, not a hand-built `/admin/oauth/authorize` URL (which 401s as "Unauthorized Access" for this app type).

Older deploy configs are still checked in and kept in sync manually: `render.yaml` (Render), `fly.toml` + `Dockerfile` (Fly.io), and `Procfile` (Heroku-style) — all just run `npm start`, but none of them have been exercised since the move to Azure App Service; treat them as unverified. `.env.example` is the canonical list of required env vars (Shopify proxy secret + `MS_*`/`SHAREPOINT_*` Graph settings for SharePoint, `MAIL_*` for email — see "Two Graph credential sets" above).

### One-off scripts (`scripts/`)

`scripts/make_pdf.js`, `scripts/query_page.js`, `scripts/update_page.js`, `scripts/update_page2.js`, and `scripts/tunnel.bat` are throwaway dev scripts for manipulating the dev store directly (generating a demo PDF into `data/demo.pdf`, reading/writing a Shopify Page's `body_html` to embed the form iframe) — they are not imported by the server and aren't part of the running app. They load `SHOPIFY_STORE`/`SHOPIFY_ADMIN_API_TOKEN` from the root `.env` via `dotenv` — never hardcode a token back into these files, since (unlike `.env`) they're tracked by git. `update_page.js` and `update_page2.js` are two historical variants of the same one-off task (different tunnel URLs); nothing currently depends on either running again.
