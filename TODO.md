# TODO

- **Move `email.js` off the vendor Graph tenant onto Yog's own.** `MAIL_*` env
  vars currently point at our own (vendor) Entra tenant/mailbox by design (see
  CLAUDE.md, "Two Graph credential sets") so onboarding doesn't block on
  merchant setup. Once Yog grants `Mail.Send` (admin consent) on their own
  tenant and hands over a licensed mailbox, repoint `MAIL_TENANT_ID` /
  `MAIL_CLIENT_ID` / `MAIL_CLIENT_SECRET` / `MAIL_FROM` at theirs — nothing
  else in `email.js` needs to change.

- **Template Designer's Save can create duplicate templates on a double
  click.** Found live on 2026-07-16: two identical "Credit Terms" (page3)
  templates (`62555023` and `b84d0489`) existed with the same `formType`,
  `nextTemplateId`, and fields, created two seconds apart — almost certainly
  the Save button firing twice before the first request's response disabled
  it (or re-enabled it). Fix by disabling the Save button (or debouncing the
  POST) for the duration of the in-flight request in
  `public/template-designer.html`. The duplicate (`b84d0489`) was deleted
  manually via `DELETE /api/templates/:id`.
