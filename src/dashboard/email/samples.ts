/** Sample data for the template preview. Every address and link uses example.com. */
import type { TemplateData, TemplateName } from '../../core/email-templates';

export const SAMPLE_DATA: { [K in TemplateName]: TemplateData[K] } = {
  'sign-in-code': { code: '482913', minutes: 10, link: 'https://example.com/sign-in/verify?token=sample' },
  'claim-code': { code: '482913', minutes: 10 },
  invite: { inviterName: 'Maya Chen', workspaceName: 'Northwind Studio', role: 'member', link: 'https://example.com/invite/sample', days: 7 },
  'email-change': { code: '482913', minutes: 10 },
  'new-device': { device: 'Chrome on macOS', ip: '203.0.113.7', time: '2026-11-18 09:30 UTC' },
  test: {},
  'export-ready': { link: 'https://example.com/export/sample', hours: 24 },
  notification: { title: 'A form got a new response', body: 'Someone filled in the contact form.', link: 'https://example.com/app', linkLabel: 'Open the dashboard' },
};

export const LANGUAGE_LABELS: Record<string, string> = { en: 'English', es: 'Español' };
