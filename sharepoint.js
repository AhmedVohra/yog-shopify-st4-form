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
const { GRAPH, getGraphToken, graphGet } = require('./graphAuth');

let cachedSiteId = null;
let cachedDriveId = null;

// SharePoint always lives in the merchant's own tenant (this is where their
// document library actually is) — never the vendor mail-sending tenant below.
function sharepointCredentials() {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  return {
    tenantId: MS_TENANT_ID,
    clientId: MS_CLIENT_ID,
    clientSecret: MS_CLIENT_SECRET,
    label: 'MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET'
  };
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

// A drive ID is self-sufficient for Graph calls (/drives/{id}/root:/...) —
// no site lookup needed when one is given directly. Only resolve via site
// + library name as a fallback when no drive ID was configured.
async function resolveDriveId(token) {
  if (cachedDriveId) return cachedDriveId;
  if (process.env.SHAREPOINT_DRIVE_ID) {
    cachedDriveId = process.env.SHAREPOINT_DRIVE_ID;
    return cachedDriveId;
  }
  const siteId = await resolveSiteId(token);
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
  const token = await getGraphToken(sharepointCredentials());
  const driveId = await resolveDriveId(token);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const folder = (process.env.SHAREPOINT_FOLDER || '').replace(/^\/+|\/+$/g, '');
  const itemPath = (folder ? folder + '/' : '') + `${stamp}_${filename}`;
  const encodedPath = itemPath.split('/').map(encodeURIComponent).join('/');

  const res = await fetch(`${GRAPH}/drives/${driveId}/root:/${encodedPath}:/content`, {
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
