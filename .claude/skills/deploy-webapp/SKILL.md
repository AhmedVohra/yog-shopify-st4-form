---
name: deploy-webapp
description: Deploy the ST-4 PDF Signer Express app to Azure App Service (yog-st4-form). User-invoked only — production deploy.
disable-model-invocation: true
---

# Deploy yog-st4-form to Azure App Service

Production target: Azure App Service Web App, Linux, Node 22, resource group
`st4-pdf-signer-rg`, app `yog-st4-form` (`https://yog-st4-form.azurewebsites.net`).

Follow these steps **in order**. Do not skip step 1 — merchants edit templates live
through the Designer between deploys, and a stale local `data/templates.json`
silently overwrites their work.

## 1. Sync `data/templates.json` from the live app first

Fetch every template from the live server and compare against local before doing
anything else:

```bash
curl -s https://yog-st4-form.azurewebsites.net/api/templates > /tmp/live-templates.json
```

Diff `/tmp/live-templates.json` against `data/templates.json`. If they differ,
pull the live copy of each individual template (`GET /api/templates/:id`) and
overwrite the local file with the live state before continuing. If you're
unsure whether a difference is a merchant edit or local work-in-progress, stop
and ask the user — don't guess and overwrite either side.

## 2. Build the deploy zip with Python's `zipfile`, not PowerShell

**Never use `Compress-Archive`** — it writes backslash path separators inside
the zip (`server\function.json`), which breaks Oryx's directory parsing.

```python
import zipfile, os

exclude_dirs = {'.git', 'node_modules', 'scripts', 'legacy', '.shopify', '.claude'}
exclude_files = {'.env'}

with zipfile.ZipFile('deploy.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith('.git')]
        for f in files:
            if f in exclude_files or f.endswith('.md'):
                continue
            path = os.path.join(root, f)
            arcname = os.path.relpath(path, '.').replace(os.sep, '/')
            z.write(path, arcname)
```

The zip must be **source-only, no `node_modules`** — `SCM_DO_BUILD_DURING_DEPLOYMENT=true`
is already set as an app setting, so Oryx runs `npm install` server-side.

## 3. Deploy

```bash
az webapp deploy --name yog-st4-form --resource-group st4-pdf-signer-rg --src-path deploy.zip --type zip
```

This is a production deploy affecting a live app merchants use — confirm with
the user before running this command unless they've explicitly asked for a
deploy in this same request.

## 4. Verify

```bash
curl -s https://yog-st4-form.azurewebsites.net/api/templates | head -c 200
```

Check the app responds and that the template count/IDs match what you deployed.
If it 503s, give it a minute — App Service warmup after a deploy can take a
short while on the F1 free tier.

If the deploy touched anything on the ST-4 Azure Function round-trip (see
CLAUDE.md), also smoke-test `GET /api/st4-status/:applicationId` with a
throwaway id — expect `{"submitted":false,...}` even if `checkedOk` comes
back `false` on the first hit (the Function's Azure SQL backend auto-pauses
when idle and can take up to ~60s to resume; a second request a minute later
should come back `checkedOk:true`).
