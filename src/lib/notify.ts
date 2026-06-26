/** Delivery helpers for the quarterly archive (Slack webhook + Resend email). */

export async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
}

export interface EmailArgs {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
  /** Optional attachment; content is base64. Skip for large files — prefer the link. */
  attachment?: { filename: string; content: string };
}

export async function sendEmail(args: EmailArgs): Promise<void> {
  const body: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    subject: args.subject,
    html: args.html,
  };
  if (args.attachment) {
    body.attachments = [{ filename: args.attachment.filename, content: args.attachment.content }];
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
