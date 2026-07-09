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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'legacy', 'pdf-signer.html')));

// Template designer — standalone (direct access) & embedded Shopify admin
app.get('/designer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'template-designer.html')));
app.get('/designer/embedded', verifyShopifyHmac, (req, res) => {
  // Embedded in Shopify admin — serve the same designer; App Bridge handles framing
  res.sendFile(path.join(__dirname, 'public', 'template-designer.html'));
});

// Customer form — standalone & via App Proxy
app.get('/form', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customer-form.html')));

// App Proxy: customer form served under store's domain
// Shopify proxies {store}.myshopify.com/apps/pdf-signer/* → {app}/proxy/*
app.get('/proxy/form', verifyProxySignature, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer-form.html'));
});
app.get('/proxy/api/templates/:id', verifyProxySignature, (req, res) => {
  // Forward template API requests from proxy context
  const templates = loadTemplates();
  const tpl = templates.find(t => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
});
app.post('/proxy/api/save-signed-pdf', verifyProxySignature, async (req, res) => {
  // Save signed PDF through the proxy
  try {
    const { filename, pdfBase64, shopifyOrderId } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 is required' });
    const buffer = Buffer.from(pdfBase64, 'base64');
    const safeName = (filename || 'signed-document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = await uploadPdfToShopify(safeName, buffer, req);
    const fileUrl = file.url || (file.preview && file.preview.image && file.preview.image.url) || null;
    if (shopifyOrderId) {
      const gid = String(shopifyOrderId).startsWith('gid://') ? shopifyOrderId : `gid://shopify/Order/${shopifyOrderId}`;
      if (fileUrl) await attachFileToOrder(gid, fileUrl, req);
    }
    res.json({ ok: true, fileId: file.id, fileUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Template storage (local JSON file) ----------
const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');

function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); }
  catch { return []; }
}
function saveTemplates(templates) {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
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
  saveTemplates(templates);
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
  saveTemplates(templates);
  res.json({ ok: true, template: templates[idx] });
});

// Delete template
app.delete('/api/templates/:id', (req, res) => {
  const templates = loadTemplates();
  const filtered = templates.filter(t => t.id !== req.params.id);
  if (filtered.length === templates.length) return res.status(404).json({ error: 'Template not found' });
  saveTemplates(filtered);
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
      .join('');
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
    // Allow direct access (no proxy)
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

  // Initiate OAuth — Shopify redirects merchant here after clicking "Install"
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

  // OAuth callback — Shopify redirects here after merchant approves
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
        .join('');
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

/**
 * Uploads a file to Shopify's Files section using the staged upload flow:
 *   1. stagedUploadsCreate -> get a signed upload URL
 *   2. PUT the file bytes to that URL
 *   3. fileCreate -> register the uploaded file with Shopify, get back a
 *      permanent, publicly reachable URL
 */
async function uploadPdfToShopify(filename, pdfBuffer, req) {
  const stagedQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;
  const stagedData = await shopifyGraphQL(stagedQuery, {
    input: [{
      filename,
      mimeType: 'application/pdf',
      httpMethod: 'POST',
      resource: 'FILE'
    }]
  }, req);

  const errs = stagedData.stagedUploadsCreate.userErrors;
  if (errs && errs.length) throw new Error('stagedUploadsCreate: ' + JSON.stringify(errs));

  const target = stagedData.stagedUploadsCreate.stagedTargets[0];

  // Shopify's staged target expects a multipart/form-data POST with the
  // given parameters, followed by the file itself.
  const FormData = require('form-data');
  const form = new FormData();
  target.parameters.forEach(p => form.append(p.name, p.value));
  form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    throw new Error('Upload to staged target failed: ' + uploadRes.status + ' ' + await uploadRes.text());
  }

  const fileCreateQuery = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          ... on GenericFile {
            url
            alt
            fileStatus
          }
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message }
      }
    }
  `;
  const fileData = await shopifyGraphQL(fileCreateQuery, {
    files: [{
      originalSource: target.resourceUrl,
      contentType: 'FILE'
    }]
  }, req);

  const fileErrs = fileData.fileCreate.userErrors;
  if (fileErrs && fileErrs.length) throw new Error('fileCreate: ' + JSON.stringify(fileErrs));

  const file = fileData.fileCreate.files[0];
  console.log('Uploaded file:', JSON.stringify(file, null, 2));
  return file;
}

/**
 * Optionally attach the resulting file URL to an order as a metafield so
 * it's visible on the order page in Shopify admin.
 */
async function attachFileToOrder(orderGid, fileUrl, req) {
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, {
    metafields: [{
      ownerId: orderGid,
      namespace: 'custom',
      key: 'signed_pdf_url',
      type: 'url',
      value: fileUrl
    }]
  }, req);
  const errs = data.metafieldsSet.userErrors;
  if (errs && errs.length) throw new Error('metafieldsSet: ' + JSON.stringify(errs));
}

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

// ---------- Save signed PDF to Shopify ----------
app.post('/api/save-signed-pdf', async (req, res) => {
  try {
    const { filename, pdfBase64, shopifyOrderId } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 is required' });

    const buffer = Buffer.from(pdfBase64, 'base64');
    const safeName = (filename || 'signed-document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');

    const file = await uploadPdfToShopify(safeName, buffer, req);
    const fileUrl = file.url || (file.preview && file.preview.image && file.preview.image.url) || null;

    if (shopifyOrderId) {
      // shopifyOrderId can be a numeric id or a full gid://shopify/Order/... string
      const gid = String(shopifyOrderId).startsWith('gid://')
        ? shopifyOrderId
        : `gid://shopify/Order/${shopifyOrderId}`;
      if (fileUrl) await attachFileToOrder(gid, fileUrl, req);
    }

    res.json({ ok: true, fileId: file.id, fileUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Shopify signed-PDF backend listening on :${PORT}`);
  startTunnel();
});

// ---------- Auto-start localtunnel (dev/testing) ----------
async function startTunnel() {
  try {
    const localtunnel = require('localtunnel');
    const subdomain = process.env.TUNNEL_SUBDOMAIN || 'yog-pdf-forms';
    
    const tunnel = await localtunnel({ port: PORT, subdomain });
    console.log(`\n🌐 Public tunnel: ${tunnel.url}\n`);
    
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
