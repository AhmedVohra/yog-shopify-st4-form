/**
 * email.js
 * -----------------------------------------------------------------------
 * Emails a copy of the signed PDF to a customer via Microsoft Graph's
 * sendMail. This intentionally uses its OWN Entra app registration
 * (MAIL_*), separate from sharepoint.js's (MS_*, the merchant's tenant).
 *
 * Why separate: this app is sold to multiple merchants, and each one
 * granting Mail.Send (application permission, admin consent) in their own
 * tenant is a setup step we can't always wait on. Pointing MAIL_* at a
 * mailbox in OUR OWN tenant means every deployment can send email
 * immediately, using our mailbox as the "from" address, with zero
 * per-merchant setup. Any given deployment can still be switched to send
 * as the merchant's own domain later — once they grant Mail.Send and hand
 * us a mailbox, just repoint MAIL_TENANT_ID/MAIL_CLIENT_ID/
 * MAIL_CLIENT_SECRET/MAIL_FROM at their tenant instead. Nothing else here
 * changes either way.
 *
 * MAIL_FROM must be a real, licensed Exchange Online mailbox in
 * MAIL_TENANT_ID — an unlicensed account fails with
 * MailboxNotEnabledForRESTAPI even with a valid token and Mail.Send.
 *
 * Required env vars: MAIL_TENANT_ID, MAIL_CLIENT_ID, MAIL_CLIENT_SECRET, MAIL_FROM
 * -----------------------------------------------------------------------
 */

const fetch = require('node-fetch');
const { GRAPH, getGraphToken } = require('./graphAuth');

const MAIL_CREDENTIALS_LABEL = 'MAIL_TENANT_ID, MAIL_CLIENT_ID, MAIL_CLIENT_SECRET, MAIL_FROM';

/**
 * Sends the signed PDF as an email attachment to the customer.
 * Graph's sendMail wants the attachment content base64-encoded.
 */
async function sendSignedPdfEmail(toEmail, filename, pdfBuffer) {
  const { MAIL_TENANT_ID, MAIL_CLIENT_ID, MAIL_CLIENT_SECRET, MAIL_FROM } = process.env;
  if (!MAIL_TENANT_ID || !MAIL_CLIENT_ID || !MAIL_CLIENT_SECRET || !MAIL_FROM) {
    throw new Error(`Email sending not configured: set ${MAIL_CREDENTIALS_LABEL}`);
  }

  const token = await getGraphToken({
    tenantId: MAIL_TENANT_ID,
    clientId: MAIL_CLIENT_ID,
    clientSecret: MAIL_CLIENT_SECRET,
    label: MAIL_CREDENTIALS_LABEL
  });
  const message = {
    subject: 'Your Signed ST-4 Form',
    body: {
      contentType: 'Text',
      content: 'Attached is a copy of your signed ST-4 form. Thank you for completing it.'
    },
    toRecipients: [{ emailAddress: { address: toEmail } }],
    attachments: [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: filename,
      contentType: 'application/pdf',
      contentBytes: pdfBuffer.toString('base64')
    }]
  };

  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(MAIL_FROM)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, saveToSentItems: 'false' })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Graph sendMail failed: ' + text);
  }
  console.log(`Emailed signed PDF to ${toEmail}`);
}

module.exports = { sendSignedPdfEmail };
