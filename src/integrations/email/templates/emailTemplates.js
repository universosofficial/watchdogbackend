/**
 * Responsive Enterprise Email Templates for Digital Watchdog
 */

export function baseEmailWrapper(title, contentHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; color: #0F172A; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 2rem auto; background: #FFFFFF; border-radius: 12px; border: 1px solid #E2E8F0; overflow: hidden; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05); }
    .header { background: linear-gradient(135deg, #0F172A 0%, #1E3A8A 100%); padding: 1.75rem 2rem; color: #FFFFFF; text-align: left; }
    .logo-badge { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: #6EE7B7; margin-bottom: 4px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.02em; }
    .body { padding: 2rem; }
    .footer { padding: 1.25rem 2rem; background: #F1F5F9; border-top: 1px solid #E2E8F0; font-size: 12px; color: #64748B; text-align: center; }
    .btn { display: inline-block; padding: 12px 24px; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 8px; margin: 16px 0; }
    .btn-primary { background: #2563EB; color: #FFFFFF; }
    .btn-emerald { background: #059669; color: #FFFFFF; }
    .card-meta { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 1rem 1.25rem; margin: 1.25rem 0; }
    .meta-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #F1F5F9; font-size: 14px; }
    .meta-row:last-child { border-bottom: none; }
    .meta-label { color: #64748B; font-weight: 500; }
    .meta-val { font-weight: 700; color: #0F172A; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-badge">DIGITAL WATCHDOG • B2B ESCROW</div>
      <h1>${title}</h1>
    </div>
    <div class="body">
      ${contentHtml}
    </div>
    <div class="footer">
      This is an automated notification from Digital Watchdog Enterprise Escrow System.<br>
      Cryptographically signed audit logs • Multi-tenant B2B milestone engine.
    </div>
  </div>
</body>
</html>`;
}

export function dealInvitationTemplate({ deal, creatorBiz, recipientName, actionUrl, workspaceUrl }) {
  const amountStr = `${deal.currency === 'USD' ? '$' : '₦'}${Number(deal.amount).toLocaleString()}`;
  const content = `
    <p>Hello <strong>${recipientName || 'Partner'}</strong>,</p>
    <p><strong>${creatorBiz.name}</strong> has invited your company to participate in a verified B2B escrow contract on Digital Watchdog.</p>
    
    <div class="card-meta">
      <div class="meta-row"><span class="meta-label">Contract Reference:</span> <span class="meta-val">#${deal.reference_no}</span></div>
      <div class="meta-row"><span class="meta-label">Contract Title:</span> <span class="meta-val">${deal.title}</span></div>
      <div class="meta-row"><span class="meta-label">Agreed Escrow Value:</span> <span class="meta-val">${amountStr}</span></div>
      <div class="meta-row"><span class="meta-label">Protection Tier:</span> <span class="meta-val">Dual-Signature Milestone Escrow</span></div>
    </div>

    <p>Both companies must digitally sign this exact agreement before work and payments unlock.</p>

    <div style="text-align: center; margin: 1.5rem 0;">
      <a href="${actionUrl}" class="btn btn-emerald" style="color: #ffffff;">✍️ 1-Click Review & Sign Agreement</a>
    </div>

    <p style="font-size: 13px; color: #64748B;">Or open in web portal: <a href="${workspaceUrl}">${workspaceUrl}</a></p>
  `;

  return baseEmailWrapper(`Invitation: Deal #${deal.reference_no}`, content);
}

export function paymentReportedTemplate({ deal, payment, confirmUrl, workspaceUrl }) {
  const amountStr = `${payment.currency === 'USD' ? '$' : '₦'}${Number(payment.reported_amount).toLocaleString()}`;
  const content = `
    <p>Hello,</p>
    <p>A payment has been logged for contract <strong>#${deal.reference_no}</strong> (${deal.title}).</p>

    <div class="card-meta">
      <div class="meta-row"><span class="meta-label">Amount Transferred:</span> <span class="meta-val" style="color: #059669; font-size: 16px;">${amountStr}</span></div>
      <div class="meta-row"><span class="meta-label">Bank Reference No:</span> <span class="meta-val">${payment.reference_no || 'PAY-REF'}</span></div>
      <div class="meta-row"><span class="meta-label">Status:</span> <span class="meta-val" style="color: #D97706;">Awaiting Recipient Confirmation</span></div>
    </div>

    <p>Please check your corporate bank account. Once the funds are received, confirm receipt below to release the next project phase:</p>

    <div style="text-align: center; margin: 1.5rem 0;">
      <a href="${confirmUrl}" class="btn btn-emerald" style="color: #ffffff;">✓ Confirm Fund Receipt</a>
    </div>

    <p style="font-size: 13px; color: #64748B;">Workspace Link: <a href="${workspaceUrl}">${workspaceUrl}</a></p>
  `;

  return baseEmailWrapper(`Payment Reported: ${amountStr} for #${deal.reference_no}`, content);
}

export function milestoneProofTemplate({ deal, obligation, uploaderBiz, workspaceUrl }) {
  const content = `
    <p>Hello,</p>
    <p><strong>${uploaderBiz?.name || 'Contractor'}</strong> has uploaded signed waybill proof or completion evidence for contract <strong>#${deal.reference_no}</strong>.</p>

    <div class="card-meta">
      <div class="meta-row"><span class="meta-label">Contract:</span> <span class="meta-val">#${deal.reference_no} — ${deal.title}</span></div>
      <div class="meta-row"><span class="meta-label">Milestone Deliverable:</span> <span class="meta-val">${obligation?.title || 'Contract Deliverable'}</span></div>
      <div class="meta-row"><span class="meta-label">Audit Verification:</span> <span class="meta-val">Submitted & Certified on Ledger</span></div>
    </div>

    <div style="text-align: center; margin: 1.5rem 0;">
      <a href="${workspaceUrl}" class="btn btn-primary" style="color: #ffffff;">Inspect Evidence & Approve Milestone</a>
    </div>
  `;

  return baseEmailWrapper(`New Evidence Uploaded for #${deal.reference_no}`, content);
}

export function overdueAlertTemplate({ deal, obligation, workspaceUrl }) {
  const content = `
    <div style="background: #FEF2F2; border-left: 4px solid #DC2626; padding: 12px 16px; border-radius: 6px; margin-bottom: 1rem;">
      <strong style="color: #DC2626;">⚠️ URGENT: Milestone Deadline Passed</strong>
    </div>

    <p>Deliverable <strong>"${obligation?.title}"</strong> on contract <strong>#${deal.reference_no}</strong> is past its scheduled deadline.</p>

    <div class="card-meta">
      <div class="meta-row"><span class="meta-label">Deal:</span> <span class="meta-val">${deal.title}</span></div>
      <div class="meta-row"><span class="meta-label">Due Date:</span> <span class="meta-val" style="color: #DC2626;">${obligation?.due_date}</span></div>
    </div>

    <p>Please upload proof of delivery immediately or request a formal deadline extension to avoid dispute escalation.</p>

    <div style="text-align: center; margin: 1.5rem 0;">
      <a href="${workspaceUrl}" class="btn btn-primary" style="color: #ffffff;">View Milestone & Request Extension</a>
    </div>
  `;

  return baseEmailWrapper(`OVERDUE ALERT: #${deal.reference_no}`, content);
}
