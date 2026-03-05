import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendViaCustomerIo } from '@/lib/email-customerio';
import { sendViaMailgun } from '@/lib/email-mailgun';
import { templates, subjects, buildCreditsSection, type TemplateName } from '@/lib/email';
import * as z from 'zod';

const templateNames: [TemplateName, ...TemplateName[]] = [
  'orgSubscription',
  'orgRenewed',
  'orgCancelled',
  'orgSSOUserJoined',
  'orgInvitation',
  'magicLink',
  'balanceAlert',
  'autoTopUpFailed',
  'ossInviteNewUser',
  'ossInviteExistingUser',
  'ossExistingOrgProvisioned',
  'deployFailed',
];

const TemplateNameSchema = z.enum(templateNames);

const providerNames = ['customerio', 'mailgun'] as const;

type ProviderName = (typeof providerNames)[number];

const ProviderNameSchema = z.enum(providerNames);

function fixtureTemplateVars(template: TemplateName): Record<string, string> {
  const orgId = 'fixture-org-id';
  const organization_url = `${NEXTAUTH_URL}/organizations/${orgId}`;
  const invoices_url = `${NEXTAUTH_URL}/organizations/${orgId}/payment-details`;
  const integrations_url = `${NEXTAUTH_URL}/organizations/${orgId}/integrations`;
  const code_reviews_url = `${NEXTAUTH_URL}/organizations/${orgId}/code-reviews`;

  switch (template) {
    case 'orgSubscription':
      return { seats: '5 seats', organization_url, invoices_url };
    case 'orgRenewed':
      return { seats: '5 seats', invoices_url };
    case 'orgCancelled':
      return { invoices_url };
    case 'orgSSOUserJoined':
      return { new_user_email: 'newuser@example.com', organization_url };
    case 'orgInvitation':
      return {
        organization_name: 'Acme Corp',
        inviter_name: 'Alice Smith',
        accept_invite_url: `${NEXTAUTH_URL}/invite/fixture-code`,
      };
    case 'magicLink':
      return {
        magic_link_url: `${NEXTAUTH_URL}/auth/magic?token=fixture-token`,
        email: 'user@example.com',
        expires_in: '24 hours',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        app_url: NEXTAUTH_URL,
      };
    case 'balanceAlert':
      return { minimum_balance: '10', organization_url, invoices_url };
    case 'autoTopUpFailed':
      return { reason: 'Card declined', credits_url: `${NEXTAUTH_URL}/credits?show-auto-top-up` };
    case 'ossInviteNewUser':
      return {
        organization_name: 'Acme OSS',
        accept_invite_url: `${NEXTAUTH_URL}/invite/fixture-oss-code`,
        integrations_url,
        code_reviews_url,
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        credits_section: buildCreditsSection(500),
      };
    case 'ossInviteExistingUser':
      return {
        organization_name: 'Acme OSS',
        organization_url,
        integrations_url,
        code_reviews_url,
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        credits_section: buildCreditsSection(500),
      };
    case 'ossExistingOrgProvisioned':
      return {
        organization_name: 'Acme OSS',
        organization_url,
        integrations_url,
        code_reviews_url,
        tier_name: 'Premier',
        seats: '25',
        seat_value: '48,000',
        credits_section: buildCreditsSection(500),
      };
    case 'deployFailed':
      return {
        deployment_name: 'my-app',
        deployment_url: `${NEXTAUTH_URL}/deployments/fixture-id`,
        repository: 'acme/my-app',
      };
  }
  throw new Error(`Unknown template: ${template}`);
}

import fs from 'fs';
import path from 'path';

function renderTemplateForPreview(
  templateName: TemplateName,
  vars: Record<string, string>
): string {
  const templatePath = path.join(process.cwd(), 'src', 'emails', `${templateName}.html`);
  const html = fs.readFileSync(templatePath, 'utf-8');
  const allVars: Record<string, string> = { ...vars, year: String(new Date().getFullYear()) };
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => allVars[key] ?? `{{${key}}}`);
}

export const emailTestingRouter = createTRPCRouter({
  getTemplates: adminProcedure.query(() => {
    return templateNames.map(name => ({ name, subject: subjects[name] }));
  }),

  getProviders: adminProcedure.query((): ProviderName[] => {
    return [...providerNames];
  }),

  getPreview: adminProcedure
    .input(z.object({ template: TemplateNameSchema, provider: ProviderNameSchema }))
    .query(({ input }) => {
      const vars = fixtureTemplateVars(input.template);
      if (input.provider === 'mailgun') {
        return {
          type: 'mailgun' as const,
          subject: subjects[input.template],
          html: renderTemplateForPreview(input.template, vars),
        };
      }
      return {
        type: 'customerio' as const,
        transactional_message_id: templates[input.template],
        subject: subjects[input.template],
        message_data: vars,
      };
    }),

  sendTest: adminProcedure
    .input(
      z.object({
        template: TemplateNameSchema,
        provider: ProviderNameSchema,
        recipient: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const vars = fixtureTemplateVars(input.template);

      if (input.provider === 'customerio') {
        await sendViaCustomerIo({
          transactional_message_id: templates[input.template],
          to: input.recipient,
          message_data: vars,
          identifiers: { email: input.recipient },
          reply_to: 'hi@kilocode.ai',
        });
        return { success: true, provider: input.provider, recipient: input.recipient };
      }

      const subject = subjects[input.template];
      const html = renderTemplateForPreview(input.template, vars);
      await sendViaMailgun({ to: input.recipient, subject, html });
      return { success: true, provider: input.provider, recipient: input.recipient };
    }),
});
