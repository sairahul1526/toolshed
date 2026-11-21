/** What each email template needs. The auth agent and other services code against these names. */
export interface TemplateData {
  'sign-in-code': { code: string; minutes: number; link: string };
  'claim-code': { code: string; minutes: number };
  invite: { inviterName: string; workspaceName: string; role: string; link: string; days: number };
  'email-change': { code: string; minutes: number };
  'new-device': { device: string; ip: string; time: string };
  test: Record<string, never>;
  'export-ready': { link: string; hours: number };
  notification: { title: string; body: string; link?: string; linkLabel?: string };
}

export type TemplateName = keyof TemplateData;

export const TEMPLATE_NAMES: TemplateName[] = [
  'sign-in-code',
  'claim-code',
  'invite',
  'email-change',
  'new-device',
  'test',
  'export-ready',
  'notification',
];

/** Who is sending and how it should look. Resolved from settings by `renderEmail`. */
export interface Brand {
  name: string;
  /** Absolute https URL of a logo the workspace chose, or null (then the name is shown as text). */
  logoUrl: string | null;
  /** Hex color such as `#4d7c0f`. */
  accent: string;
  footer: string | null;
}

/** Plain, unescaped copy for one email. The layout escapes it and builds the HTML and text parts. */
export interface Content {
  subject: string;
  /** The grey preview line some inboxes show after the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** A one-time code, shown large and easy to copy. */
  code?: string;
  button?: { label: string; href: string };
  /** Said above the button, for example "Or open this link to sign in without typing the code:". */
  buttonIntro?: string;
  /** Small print under the button. */
  small?: string[];
}

export type Messages = {
  [K in TemplateName]: (data: TemplateData[K], brand: Brand) => Content;
} & {
  common: {
    sentBy: (brand: string) => string;
    ignore: string;
    linkFallback: string;
  };
};
