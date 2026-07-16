# TODO

- **Move `email.js` off the vendor Graph tenant onto Yog's own.** `MAIL_*` env
  vars currently point at our own (vendor) Entra tenant/mailbox by design (see
  CLAUDE.md, "Two Graph credential sets") so onboarding doesn't block on
  merchant setup. Once Yog grants `Mail.Send` (admin consent) on their own
  tenant and hands over a licensed mailbox, repoint `MAIL_TENANT_ID` /
  `MAIL_CLIENT_ID` / `MAIL_CLIENT_SECRET` / `MAIL_FROM` at theirs — nothing
  else in `email.js` needs to change.
