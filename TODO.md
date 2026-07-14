# TODO

- **Detect already-submitted ST-4 on load.** A customer can reach the ST-4 form
  two ways for the same `applicationId`: the immediate post-submit redirect
  from the apply-account page, and the `send-st4-link` fallback email (see the
  Azure Function repo's CLAUDE.md, "Azure Function round-trip" incident,
  2026-07-14). If they already completed it via one path and then click the
  other (e.g. the email link after already signing via the redirect),
  `customer-form.html` should detect this and show "already submitted"
  instead of letting them fill and resubmit. Needs a way to check submission
  status for a given `applicationId` — either a new endpoint on this server
  that asks the Azure Function, or the Function passing an already-signed
  flag/status back through the link itself.

- **Move `email.js` off the vendor Graph tenant onto Yog's own.** `MAIL_*` env
  vars currently point at our own (vendor) Entra tenant/mailbox by design (see
  CLAUDE.md, "Two Graph credential sets") so onboarding doesn't block on
  merchant setup. Once Yog grants `Mail.Send` (admin consent) on their own
  tenant and hands over a licensed mailbox, repoint `MAIL_TENANT_ID` /
  `MAIL_CLIENT_ID` / `MAIL_CLIENT_SECRET` / `MAIL_FROM` at theirs — nothing
  else in `email.js` needs to change.
