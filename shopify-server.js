/**
 * shopify-server.js
 * -----------------------------------------------------------------------
 * Minimal backend that receives the signed PDF from pdf-signer.html and
 * pushes it into Shopify using the Admin API. This has to live on a
 * server (not in the browser) because it needs your app's Admin API
 * access token, which must never be exposed to a customer's browser.
 *
 * What it does, end to end:
 *   1. pdf-signer.html POSTs { filename, pdfBase64, shopifyOrderId, shopifyCustomerId }
 *      to POST /api/save-signed-pdf
 *   2. This server uploads the PDF to Shopify's Files (via a staged upload,
 *      which is how the Admin API accepts binary files)
 *   3. If an order id was passed in, it also writes the resulting file URL
 *      onto that order as a metafield, so it shows up next to the order
 *      in the Shopify admin.
 *
 * Setup:
 *   npm install express node-fetch@2 dotenv
 *   Create a .env file with:
 *     SHOPIFY_STORE=your-store.myshopify.com
 *     SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxx
 *     PORT=3001
 *
 *   node shopify-server.js
 *
 * In pdf-signer.html, set (before the closing </script> or via a small
 * inline <script> tag above it):
 *     window.SHOPIFY_UPLOAD_ENDPOINT = 'https://your-backend.example.com/api/save-signed-pdf';
 *     window.SHOPIFY_ORDER_ID = '820982911946154508';       // optional
 *     window.SHOPIFY_CUSTOMER_ID = '207119551';              // optional
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uploadPdfToSharePoint } = require('./sharepoint');
const { sendSignedPdfEmail, sendST4FormLinkEmail } = require('./email');

const app = express();
app.use(express.json({ limit: '25mb' })); // signed PDFs are small, but leave headroom

// ---------- Session (for OAuth & Shopify admin sessions) ----------
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ---------- Serve static files ----------
app.use(express.static(path.join(__dirname, 'public')));
// ---------- Core routes ----------
app.get('/', (req, res) => res.redirect('/designer'));

// Template designer â€” standalone (direct access) & embedded Shopify admin
app.get('/designer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'template-designer.html')));
app.get('/designer/embedded', verifyShopifyHmac, (req, res) => {
  // Embedded in Shopify admin â€” serve the same designer; App Bridge handles framing
  res.sendFile(path.join(__dirname, 'public', 'template-designer.html'));
});

// Customer form â€” standalone & via App Proxy
app.get('/form', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customer-form.html')));

// App Proxy: customer form served under store's domain
// Shopify proxies {store}.myshopify.com/apps/pdf-signer/* â†’ {app}/proxy/*
//
// Served as Content-Type: application/liquid so Shopify renders the form
// INSIDE the store theme (header/footer). Shopify injects the response body
// into the theme layout, so this must be a body fragment (style + markup +
// scripts), never a full HTML document. Liquid also parses the content â€”
// customer-form.html must stay free of literal {{ and {% sequences.
let liquidFragmentCache = null;
function buildLiquidFragment() {
  if (liquidFragmentCache) return liquidFragmentCache;
  const html = fs.readFileSync(path.join(__dirname, 'public', 'customer-form.html'), 'utf8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
  if (!styleMatch || !bodyMatch) throw new Error('customer-form.html: could not extract <style>/<body> for Liquid fragment');
  // Shopify owns <body> in the theme layout, so re-scope the form's body
  // rule to the wrapper div and stop claiming the full viewport height.
  const css = styleMatch[1]
    .replace(/\nbody \{/, '\n#pdfSignerRoot {')
    .replace('min-height: 100vh', 'min-height: 80vh');
  liquidFragmentCache = `<style>${css}</style>\n<div id="pdfSignerRoot">${bodyMatch[1]}</div>`;
  return liquidFragmentCache;
}
app.get('/proxy/form', verifyProxySignature, (req, res) => {
  try {
    res.set('Content-Type', 'application/liquid').send(buildLiquidFragment());
  } catch (err) {
    console.error(err);
    res.status(500).send('Form unavailable');
  }
});
app.get('/proxy/api/templates/:id', verifyProxySignature, (req, res) => {
  // Forward template API requests from proxy context
  const templates = loadTemplates();
  const tpl = templates.find(t => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
});
app.post('/proxy/api/save-signed-pdf', verifyProxySignature, handleSaveSignedPdf);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shared by the direct and proxied routes: signed PDFs go to SharePoint,
// and optionally emailed to the customer (best-effort — a failed email
// shouldn't fail the submission, since the PDF is already safely stored).
// If applicationId is provided, also notifies the Azure Function to update BC.
async function handleSaveSignedPdf(req, res) {
  try {
    const { filename, pdfBase64, email, applicationId } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 is required' });
    const buffer = Buffer.from(pdfBase64, 'base64');
    const safeName = (filename || 'signed-document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = await uploadPdfToSharePoint(safeName, buffer);

    let emailed = false;
    if (email && EMAIL_RE.test(email)) {
      try {
        await sendSignedPdfEmail(email, safeName, buffer);
        emailed = true;
      } catch (emailErr) {
        console.error('Failed to email signed PDF to', email, emailErr);
      }
    }

    // Notify BC via Azure Function — best-effort, non-blocking
    let bcNotified = false;
    if (applicationId && process.env.AZURE_FUNCTION_URL) {
      try {
        // AZURE_FUNCTION_URL may already carry ?code=<function key>
        const azureUrl = process.env.AZURE_FUNCTION_URL;
        const azureRes = await fetch(
          `${azureUrl}${azureUrl.includes('?') ? '&' : '?'}type=st4notify`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.AZURE_FUNCTION_API_KEY || ''
            },
            body: JSON.stringify({
              applicationId,
              st4PdfUrl: file.webUrl
            })
          }
        );
        if (azureRes.ok) {
          bcNotified = true;
          console.log(`BC notified for applicationId: ${applicationId}`);
        } else {
          const errBody = await azureRes.text().catch(() => '');
          console.error(`Azure Function returned ${azureRes.status} for BC notify: ${errBody}`);
        }
      } catch (bcErr) {
        console.error('BC notification failed (non-fatal):', bcErr.message);
      }
    }

    res.json({ ok: true, fileId: file.id, fileUrl: file.webUrl, emailed, bcNotified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

// ---------- Template storage (local JSON file) ----------
const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');

function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); }
  catch { return []; }
}
function saveTemplates(templates) {
  // On Azure Functions the deployed filesystem is read-only — templates.json
  // is baked-in seed data there and designer edits require a redeploy.
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
  } catch (err) {
    console.error('saveTemplates failed:', err.message);
    const e = new Error('Template storage is read-only in this deployment');
    e.readOnlyStorage = true;
    throw e;
  }
}
function templateWriteError(res, err) {
  if (err && err.readOnlyStorage) return res.status(503).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: err.message });
}

// List all templates
app.get('/api/templates', (req, res) => {
  const templates = loadTemplates();
  res.json(templates.map(t => ({ id: t.id, name: t.name, pdfFileName: t.pdfFileName, fieldCount: (t.fields || []).length, createdAt: t.createdAt })));
});

// Get single template
app.get('/api/templates/:id', (req, res) => {
  const templates = loadTemplates();
  const tpl = templates.find(t => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
});

// Create template
app.post('/api/templates', (req, res) => {
  const { name, pdfFileName, pdfBase64, fields } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const templates = loadTemplates();
  const tpl = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    pdfFileName: pdfFileName || 'document.pdf',
    pdfBase64: pdfBase64 || '',
    fields: fields || [],
    createdAt: new Date().toISOString()
  };
  templates.push(tpl);
  try { saveTemplates(templates); } catch (err) { return templateWriteError(res, err); }
  res.json({ ok: true, template: tpl });
});

// Update template
app.put('/api/templates/:id', (req, res) => {
  const templates = loadTemplates();
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  const { name, fields, pdfBase64, pdfFileName } = req.body;
  if (name !== undefined) templates[idx].name = name;
  if (fields !== undefined) templates[idx].fields = fields;
  if (pdfBase64 !== undefined) templates[idx].pdfBase64 = pdfBase64;
  if (pdfFileName !== undefined) templates[idx].pdfFileName = pdfFileName;
  templates[idx].updatedAt = new Date().toISOString();
  try { saveTemplates(templates); } catch (err) { return templateWriteError(res, err); }
  res.json({ ok: true, template: templates[idx] });
});

// Delete template
app.delete('/api/templates/:id', (req, res) => {
  const templates = loadTemplates();
  const filtered = templates.filter(t => t.id !== req.params.id);
  if (filtered.length === templates.length) return res.status(404).json({ error: 'Template not found' });
  try { saveTemplates(filtered); } catch (err) { return templateWriteError(res, err); }
  res.json({ ok: true });
});

const SHOP = process.env.SHOPIFY_STORE;                 // e.g. "my-shop.myshopify.com"
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;       // Admin API access token
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;          // OAuth client ID
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;  // OAuth client secret
const API_VERSION = '2024-10';
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;

// ---------- Shopify HMAC verification ----------
// Verifies requests coming from Shopify (embedded app, proxy, webhooks)
function verifyShopifyHmac(req, res, next) {
  // If the request has an hmac param, verify it
  const { hmac, signature, ...params } = req.query;
  
  // If there's an hmac, validate it
  if (hmac) {
    const message = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&');
    const generated = crypto.createHmac('sha256', CLIENT_SECRET)
      .update(message)
      .digest('hex');
    if (generated !== hmac) {
      console.warn('HMAC verification failed');
      return res.status(401).send('HMAC verification failed');
    }
    // Store the shop domain in the session for later use
    if (params.shop) req.session.shop = params.shop;
    return next();
  }
  
  // If no hmac but we have a session, allow through (already authenticated)
  if (req.session && req.session.shop) return next();
  
  // If this is a request from Shopify's embedded app (has session token header)
  const sessionToken = req.headers['authorization'] || req.get('Authorization');
  if (sessionToken) {
    // For session token based auth (newer Shopify embedded apps), 
    // we'd verify the JWT here. For now, let the session carry it.
    return next();
  }
  
  // No auth required for direct access (standalone mode)
  next();
}

// ---------- App Proxy signature verification ----------
// Shopify app proxy signs requests with a signature param
function verifyProxySignature(req, res, next) {
  const { signature, ...params } = req.query;
  
  if (!signature) {
    // In production (Azure) only Shopify-signed proxy requests are allowed;
    // locally, unsigned direct access is kept for tunnel/standalone testing.
    if (process.env.REQUIRE_PROXY_SIGNATURE === '1') {
      return res.status(401).send('Missing proxy signature');
    }
    return next();
  }
  
  // Verify the proxy signature using the app's client secret
  const message = Object.keys(params)
    .sort()
    .map(k => {
      // Replace % with %25 and = with %3D in both key and value (Shopify's proxy encoding)
      const key = k.replace(/%/g, '%25').replace(/=/g, '%3D');
      const val = (params[k] || '').replace(/%/g, '%25').replace(/=/g, '%3D');
      return `${key}=${val}`;
    })
    .join('');
  
  const generated = crypto.createHmac('sha256', CLIENT_SECRET)
    .update(message)
    .digest('hex');
  
  if (generated !== signature) {
    console.warn('Proxy signature verification failed');
    return res.status(401).send('Invalid proxy signature');
  }
  
  // Store shop from proxied request
  if (params.shop) req.session.shop = params.shop;
  next();
}

// ---------- OAuth / Install flow ----------
// When no direct API token is available, use OAuth to get one per-session
const needsOAuth = (!TOKEN || TOKEN.startsWith('shpss_')) && CLIENT_ID && CLIENT_SECRET;

if (needsOAuth) {
  const redirectUri = `${APP_URL}/auth/callback`;

  // Initiate OAuth â€” Shopify redirects merchant here after clicking "Install"
  app.get('/auth', (req, res) => {
    const shop = req.query.shop;
    if (!shop) {
      return res.status(400).send('Missing shop parameter. Use ?shop=your-store.myshopify.com');
    }
    req.session.shop = shop;
    const scopes = 'write_files,read_files,write_orders,read_orders,read_themes,write_themes,read_content,write_content';
    const authUrl = `https://${shop}/admin/oauth/authorize?` +
      `client_id=${CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(authUrl);
  });

  // OAuth callback â€” Shopify redirects here after merchant approves
  app.get('/auth/callback', async (req, res) => {
    try {
      const { code, hmac, shop } = req.query;
      if (!code) return res.status(400).send('Missing authorization code.');

      // Verify HMAC
      const paramsToVerify = { ...req.query };
      delete paramsToVerify.hmac;
      const message = Object.keys(paramsToVerify)
        .sort()
        .map(k => `${k}=${paramsToVerify[k]}`)
        .join('&');
      const generated = crypto.createHmac('sha256', CLIENT_SECRET)
        .update(message).digest('hex');
      if (generated !== hmac) return res.status(401).send('HMAC verification failed.');

      // Exchange code for access token
      const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
      });
      const tokenData = await tokenResp.json();
      if (tokenData.errors) throw new Error(JSON.stringify(tokenData.errors));

      // Store token in session
      req.session.accessToken = tokenData.access_token;
      req.session.shop = shop;

      console.log(`OAuth successful for shop: ${shop}`);
      
      // Redirect to embedded app in Shopify Admin
      res.redirect(`https://${shop}/admin/apps`);
    } catch (err) {
      console.error('OAuth error:', err);
      res.status(500).send('OAuth failed: ' + err.message);
    }
  });

  // Middleware to attach session token to requests
  app.use('/api', (req, res, next) => {
    if (req.session && req.session.accessToken) {
      req.shopifyAccessToken = req.session.accessToken;
    }
    next();
  });

  console.log('\n=== OAuth required ===');
  console.log(`Install the app by visiting: ${APP_URL}/auth?shop=${SHOP || 'your-store.myshopify.com'}`);
  console.log('=======================\n');
}

// ---------- Shopify API helpers ----------
function getShopifyToken() {
  // Use session token first (OAuth), fall back to env var
  // This is used by the GraphQL/API calls
  return TOKEN && !TOKEN.startsWith('shpss_') ? TOKEN : null;
}

function adminUrl(shop, restPath) {
  return `https://${shop}/admin/api/${API_VERSION}/${restPath}`;
}

async function shopifyGraphQL(query, variables, req) {
  // Try session token first, then env token
  let token = (req && req.session && req.session.accessToken) || getShopifyToken();
  if (!token) throw new Error('No Shopify access token. Run OAuth first: ' + APP_URL + '/auth?shop=' + SHOP);
  
  const shop = (req && req.session && req.session.shop) || SHOP;
  if (!shop) throw new Error('No shop configured.');
  
  const res = await fetch(adminUrl(shop, 'graphql.json'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

// Signed PDFs are stored in SharePoint (see sharepoint.js) — the previous
// Shopify Files staged-upload / order-metafield flow was removed.

// ---------- Utility: Disable store password ----------
app.post('/api/store/disable-password', async (req, res) => {
  try {
    const token = getShopifyToken();
    if (!token) return res.status(400).json({ error: 'No Shopify token configured. Set SHOPIFY_ADMIN_API_TOKEN in .env' });
    const shop = SHOP;
    if (!shop) return res.status(400).json({ error: 'SHOPIFY_STORE not set in .env' });

    const resp = await fetch(`https://${shop}/admin/api/${API_VERSION}/shop.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ shop: { password_enabled: false } })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data.errors || resp.statusText });
    res.json({ ok: true, shop: data.shop });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Save signed PDF (direct route; same handler as the proxy) ----------
app.post('/api/save-signed-pdf', handleSaveSignedPdf);

// ---------- Send ST-4 form link to customer ----------
// Called by the Azure Function after a new application is submitted, so the
// customer receives a personalised link with their applicationId already in the URL.
// Body: { email, customerName, applicationId, templateId }
app.post('/api/send-st4-link', async (req, res) => {
  try {
    const { email, customerName, applicationId, templateId } = req.body || {};
    if (!email)          return res.status(400).json({ error: 'email is required' });
    if (!applicationId) return res.status(400).json({ error: 'applicationId is required' });
    if (!templateId)    return res.status(400).json({ error: 'templateId is required' });

    const APP_ORIGIN = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
    const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

    // Prefer the proxied store URL so customers see the form under the store domain
    const baseUrl = SHOPIFY_STORE
      ? `https://${SHOPIFY_STORE}/apps/pdf-signer/form?id=${encodeURIComponent(templateId)}`
      : `${APP_ORIGIN}/form?id=${encodeURIComponent(templateId)}`;

    const formUrl = `${baseUrl}&email=${encodeURIComponent(email)}&applicationId=${encodeURIComponent(applicationId)}`;

    await sendST4FormLinkEmail(email, customerName || '', formUrl);
    res.json({ ok: true, formUrl });
  } catch (err) {
    console.error('send-st4-link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Azure App Service (Linux) sets PORT itself; locally we fall back to 3001.
const PORT = process.env.PORT || 3001;
const IN_AZURE = !!process.env.WEBSITE_HOSTNAME;
// Bind all interfaces — Azure's warmup/health probe reaches the container
// over its external network interface, not literal loopback.
app.listen(PORT, () => {
  console.log(`Shopify signed-PDF backend listening on :${PORT}`);
  if (!IN_AZURE && process.env.DISABLE_TUNNEL !== '1') startTunnel();
});

// ---------- Auto-start localtunnel (dev/testing) ----------
async function startTunnel() {
  try {
    const localtunnel = require('localtunnel');
    const subdomain = process.env.TUNNEL_SUBDOMAIN || 'yog-pdf-forms';
    
    const tunnel = await localtunnel({ port: PORT, subdomain });
    console.log(`\nðŸŒ Public tunnel: ${tunnel.url}\n`);
    
    tunnel.on('close', () => {
      console.log('Tunnel closed. Restarting in 5s...');
      setTimeout(startTunnel, 5000);
    });
    
    tunnel.on('error', (err) => {
      console.error('Tunnel error:', err.message);
    });
    
    // Store for graceful shutdown
    if (global._tunnel) global._tunnel.close();
    global._tunnel = tunnel;
  } catch (err) {
    console.error('Failed to start tunnel:', err.message);
    console.log('Retrying in 10s...');
    setTimeout(startTunnel, 10000);
  }
}
