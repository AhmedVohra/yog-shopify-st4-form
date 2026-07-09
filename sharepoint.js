/**
 * sharepoint.js
 * -----------------------------------------------------------------------
 * Uploads signed PDFs to a SharePoint document library via Microsoft Graph
 * using client-credentials (an Entra app registration with application
 * permission Sites.ReadWrite.All, or Sites.Selected + a grant on the site).
 *
 * Required env vars:
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
 * Target selection (either give the IDs directly, or let this module
 * resolve them once and cache them):
 *   SHAREPOINT_SITE_ID                       — Graph site id, or:
 *   SHAREPOINT_HOSTNAME + SHAREPOINT_SITE_PATH  — e.g. "contoso.sharepoint.com" + "/sites/Finance"
 *   SHAREPOINT_DRIVE_ID                      — Graph drive id, or:
 *   SHAREPOINT_LIBRARY                       — document library name (default "Documents")
 * Optional:
 *   SHAREPOINT_FOLDER                        — folder path inside the library (e.g. "Signed ST-4")
 * -----------------------------------------------------------------------
 */

const fetch = require('node-fetch');

const GRAPH = 'https://graph.microsoft.com/v1.0';

let cachedToken = null;   // { token, expiresAt (ms epoch) }
let cachedSiteId = null;
let cachedDriveId = null;

async function getGraphToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 2 * 60 * 1000) {
    return cachedToken.token;
  }
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('SharePoint upload not configured: set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default'
  });
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error('Graph token request failed: ' + (json.error_description || JSON.stringify(json)));
  }
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in * 1000) };
  return cachedToken.token;
}

async function graphGet(pathname, token) {
  const res = await fetch(`${GRAPH}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Graph GET ${pathname} failed: ` + JSON.stringify(json.error || json));
  return json;
}

async function resolveSiteId(token) {
  if (cachedSiteId) return cachedSiteId;
  if (process.env.SHAREPOINT_SITE_ID) {
    cachedSiteId = process.env.SHAREPOINT_SITE_ID;
    return cachedSiteId;
  }
  const host = process.env.SHAREPOINT_HOSTNAME;
  const sitePath = process.env.SHAREPOINT_SITE_PATH;
  if (!host || !sitePath) {
    throw new Error('Set SHAREPOINT_SITE_ID, or SHAREPOINT_HOSTNAME + SHAREPOINT_SITE_PATH');
  }
  const site = await graphGet(`/sites/${host}:${sitePath.startsWith('/') ? sitePath : '/' + sitePath}`, token);
  cachedSiteId = site.id;
  return cachedSiteId;
}

async function resolveDriveId(token, siteId) {
  if (cachedDriveId) return cachedDriveId;
  if (process.env.SHAREPOINT_DRIVE_ID) {
    cachedDriveId = process.env.SHAREPOINT_DRIVE_ID;
    return cachedDriveId;
  }
  const libraryName = process.env.SHAREPOINT_LIBRARY || 'Documents';
  const drives = await graphGet(`/sites/${siteId}/drives`, token);
  const drive = (drives.value || []).find(d => d.name === libraryName);
  if (!drive) {
    const names = (drives.value || []).map(d => d.name).join(', ');
    throw new Error(`Document library "${libraryName}" not found on site. Available drives: ${names}`);
  }
  cachedDriveId = drive.id;
  return cachedDriveId;
}

/**
 * Uploads a PDF buffer to the configured SharePoint library.
 * The stored name is prefixed with a timestamp so repeat submissions
 * never overwrite each other (Graph PUT silently replaces same names).
 * Returns { id, webUrl, name } of the created drive item.
 */
async function uploadPdfToSharePoint(filename, pdfBuffer) {
  const token = await getGraphToken();
  const siteId = await resolveSiteId(token);
  const driveId = await resolveDriveId(token, siteId);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const folder = (process.env.SHAREPOINT_FOLDER || '').replace(/^\/+|\/+$/g, '');
  const itemPath = (folder ? folder + '/' : '') + `${stamp}_${filename}`;
  const encodedPath = itemPath.split('/').map(encodeURIComponent).join('/');

  const res = await fetch(`${GRAPH}/sites/${siteId}/drives/${driveId}/root:/${encodedPath}:/content`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf'
    },
    body: pdfBuffer
  });
  const json = await res.json();
  if (!res.ok) throw new Error('SharePoint upload failed: ' + JSON.stringify(json.error || json));

  console.log(`Uploaded to SharePoint: ${json.name} (${json.webUrl})`);
  return { id: json.id, webUrl: json.webUrl, name: json.name };
}

module.exports = { uploadPdfToSharePoint };
