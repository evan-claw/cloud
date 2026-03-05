import Mailgun from 'mailgun.js';
import FormData from 'form-data';
import { MAILGUN_API_KEY, MAILGUN_DOMAIN } from '@/lib/config.server';

const mailgun = new Mailgun(FormData);

type SendViaMailgunParams = {
  to: string;
  subject: string;
  html: string;
};

export async function sendViaMailgun({ to, subject, html }: SendViaMailgunParams) {
  const client = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });
  await client.messages.create(MAILGUN_DOMAIN, {
    from: 'Kilo Code <noreply@app.kilocode.ai>',
    to,
    subject,
    html,
  });
}
