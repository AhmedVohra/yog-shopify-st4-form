/**
 * graphAuth.js
 * -----------------------------------------------------------------------
 * Microsoft Graph client-credentials token fetch, shared by sharepoint.js
 * and email.js. Those two callers intentionally use DIFFERENT Entra app
 * registrations / tenants (see each module for why) — so this caches one
 * token per clientId rather than a single global token, and takes the
 * credential set explicitly instead of reading fixed env var names.
 * -----------------------------------------------------------------------
 */

const fetch = require('node-fetch');

const GRAPH = 'https://graph.microsoft.com/v1.0';

const tokenCache = new Map(); // clientId -> { token, expiresAt (ms epoch) }

async function getGraphToken({ tenantId, clientId, clientSecret, label }) {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(`Microsoft Graph not configured: set ${label || 'tenantId, clientId, clientSecret'}`);
  }
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt - Date.now() > 2 * 60 * 1000) {
    return cached.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default'
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error('Graph token request failed: ' + (json.error_description || JSON.stringify(json)));
  }
  const entry = { token: json.access_token, expiresAt: Date.now() + (json.expires_in * 1000) };
  tokenCache.set(clientId, entry);
  return entry.token;
}

async function graphGet(pathname, token) {
  const res = await fetch(`${GRAPH}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Graph GET ${pathname} failed: ` + JSON.stringify(json.error || json));
  return json;
}

module.exports = { GRAPH, getGraphToken, graphGet };
