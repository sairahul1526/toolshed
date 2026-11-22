/** The pages strangers see: notices, password gate, link preview, report form, social preview, bio pages. */
import { html, raw } from 'hono/html';
import { PublicButton, PublicCard, PublicField, PublicInput, PublicPage, type Appearance } from '../../ui';
import { REPORT_REASONS } from './abuse';
import type { BioRow, BlockRow } from './bios';
import { bioColors } from './bios';
import type { LinkState } from './types';

const STYLES = ['/m/links/links-public.css'];

const NOTICES: Record<Exclude<LinkState, 'live'>, { title: string; body: string }> = {
  expired: { title: 'This link has expired', body: 'Whoever shared it set it to stop working after a certain time. Ask them for a new one.' },
  scheduled: { title: 'This link is not live yet', body: 'It has not started working. Try again later.' },
  capped: { title: 'This link has reached its limit', body: 'It stopped working after enough people used it. Ask whoever shared it for a new one.' },
  archived: { title: 'This link is not available', body: 'The person who made it has taken it down.' },
  disabled: { title: 'This link is not available', body: 'It has been switched off.' },
};

export const noticeStatus = (state: Exclude<LinkState, 'live'>): 404 | 410 => (state === 'scheduled' ? 404 : 410);

export function NoticePage({ state, appearance }: { state: Exclude<LinkState, 'live'>; appearance: Appearance }) {
  const n = NOTICES[state];
  return (
    <PublicPage title={n.title} appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>{n.title}</h1>
        <p>{n.body}</p>
      </PublicCard>
    </PublicPage>
  );
}

export function PasswordPage({ code, error, appearance }: { code: string; error?: string; appearance: Appearance }) {
  return (
    <PublicPage title="Password needed" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>This link needs a password</h1>
        <p>Enter the password you were given to continue.</p>
        <form method="post" action={`/l/p/${code}`} class="lk-form">
          <PublicField id="password" label="Password" error={error}>
            <PublicInput id="password" type="password" required autocomplete="off" invalid={!!error} describedBy={error ? 'password-error' : undefined} maxlength={256} />
          </PublicField>
          <PublicButton type="submit" block>
            Continue
          </PublicButton>
        </form>
      </PublicCard>
    </PublicPage>
  );
}

export interface PreviewInfo {
  code: string;
  shortUrl: string;
  title: string;
  /** Empty when the link is protected by a password: the address stays private. */
  destination: string;
  protectedByPassword: boolean;
  state: LinkState;
}

export function PreviewPage({ info, appearance }: { info: PreviewInfo; appearance: Appearance }) {
  const live = info.state === 'live';
  return (
    <PublicPage title="Link preview" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>{info.title || 'Where this link goes'}</h1>
        <p class="lk-small">Check the address before you continue.</p>
        <span class="pub-url">{info.shortUrl}</span>
        {info.protectedByPassword ? <p>The destination is hidden. You need a password to continue.</p> : <span class="pub-url" data-role="destination">{info.destination}</span>}
        {!live ? <p>This link is not working right now.</p> : null}
        {live ? (
          <PublicButton href={info.shortUrl} block>
            Continue
          </PublicButton>
        ) : null}
        <p class="lk-small">
          <a href={`/l/report/${info.code}`}>Report this link</a>
        </p>
      </PublicCard>
    </PublicPage>
  );
}

const REASON_LABELS: Record<(typeof REPORT_REASONS)[number], string> = {
  spam: 'Spam or misleading',
  phishing: 'Tries to steal passwords or payment details',
  malware: 'Spreads harmful software',
  illegal: 'Illegal content',
  other: 'Something else',
};

export function ReportPage({ code, token, error, values, appearance }: { code: string; token: string; error?: string; values?: { reason?: string; details?: string; contact?: string }; appearance: Appearance }) {
  return (
    <PublicPage title="Report a link" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>Report this link</h1>
        <p>Tell us what is wrong with the short link below. The person in charge of it will be told.</p>
        <span class="pub-url">{`/${code}`}</span>
        <form method="post" action={`/l/report/${code}`} class="lk-form">
          <input type="hidden" name="t" value={token} />
          <div class="lk-hp" aria-hidden="true">
            <label for="website">Leave this empty</label>
            <input id="website" name="website" type="text" tabindex={-1} autocomplete="off" />
          </div>
          <fieldset class="lk-reasons">
            <legend>What is wrong</legend>
            {REPORT_REASONS.map((r) => (
              <label class="lk-radio">
                <input type="radio" name="reason" value={r} checked={values?.reason === r} required />
                <span>{REASON_LABELS[r]}</span>
              </label>
            ))}
          </fieldset>
          <PublicField id="details" label="Details" optional>
            <textarea class="pub-input" id="details" name="details" rows={4} maxlength={1000}>
              {values?.details ?? ''}
            </textarea>
          </PublicField>
          <PublicField id="contact" label="Your email, if you want a reply" optional hint="We only use it to follow up on this report.">
            <PublicInput id="contact" type="email" inputmode="email" autocomplete="email" maxlength={200} value={values?.contact} describedBy="contact-hint" />
          </PublicField>
          {error ? (
            <p class="pub-error" role="alert">
              {error}
            </p>
          ) : null}
          <PublicButton type="submit" block>
            Send report
          </PublicButton>
        </form>
      </PublicCard>
    </PublicPage>
  );
}

export function ReportDonePage({ appearance }: { appearance: Appearance }) {
  return (
    <PublicPage title="Report sent" appearance={appearance} styles={STYLES}>
      <PublicCard>
        <h1>Thanks, we got it</h1>
        <p>The person in charge of this link will look at your report.</p>
      </PublicCard>
    </PublicPage>
  );
}

/** What chat apps and search bots read: Open Graph and Twitter tags, nothing else. People never see this page. */
export function socialPreviewHtml(opts: { url: string; title: string; description: string; image: string }): string {
  const { url, title, description, image } = opts;
  const out = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:url" content="${url}"><meta property="og:title" content="${title}">
${description ? html`<meta property="og:description" content="${description}"><meta name="description" content="${description}">` : ''}
${image ? html`<meta property="og:image" content="${image}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${title}">
${description ? html`<meta name="twitter:description" content="${description}">` : ''}
${image ? html`<meta name="twitter:image" content="${image}">` : ''}
</head><body><h1>${title}</h1>${description ? html`<p>${description}</p>` : ''}</body></html>`;
  return out.toString();
}

// ---------------------------------------------------------------------------------------------
// Bio pages
// ---------------------------------------------------------------------------------------------

const PLATFORM_LABELS: Record<string, string> = {
  website: 'Website', x: 'X', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn', github: 'GitHub',
  facebook: 'Facebook', threads: 'Threads', mastodon: 'Mastodon', bluesky: 'Bluesky', twitch: 'Twitch', discord: 'Discord', email: 'Email',
};

const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0] ?? '').join('').toUpperCase() || '?';

/** The whole bio page. Plain links and text, no script, so it loads fast and works everywhere. */
export function BioPage({ bio, blocks, appearance }: { bio: BioRow; blocks: BlockRow[]; appearance: Appearance }) {
  const custom = bio.theme === 'custom';
  const styles = custom ? [...STYLES, `/l/s/${bio.code}.css?v=${bio.updated_at}`] : STYLES;
  const title = bio.seo_title || bio.name || bio.code;
  const description = bio.seo_description || bio.bio;
  const socials = blocks.filter((b) => b.kind === 'social');
  const rest = blocks.filter((b) => b.kind !== 'social');
  return (
    <PublicPage title={title} appearance={appearance} styles={styles} wide indexable={bio.noindex !== 1} description={description || undefined}>
      <div class="lk-bio">
        <header class="lk-bio-head">
          {bio.avatar_url ? <img class="lk-avatar" src={bio.avatar_url} alt="" width="88" height="88" loading="lazy" referrerpolicy="no-referrer" /> : <span class="lk-avatar lk-initials" aria-hidden="true">{initialsOf(bio.name || bio.code)}</span>}
          {bio.name ? <h1>{bio.name}</h1> : null}
          {bio.bio ? <p>{bio.bio}</p> : null}
        </header>
        <ul class="lk-blocks">
          {rest.map((b) =>
            b.kind === 'link' ? (
              <li>
                <a class="lk-btn" href={`/l/b/${b.id}`} rel="nofollow noopener">
                  {b.title}
                </a>
              </li>
            ) : b.kind === 'heading' ? (
              <li class="lk-heading">
                <h2>{b.title}</h2>
              </li>
            ) : (
              <li class="lk-text">
                <p>{b.body}</p>
              </li>
            ),
          )}
        </ul>
        {socials.length ? (
          <ul class="lk-socials" aria-label="Social links">
            {socials.map((b) => (
              <li>
                <a class="lk-soc" href={`/l/b/${b.id}`} rel="nofollow noopener">
                  {PLATFORM_LABELS[b.platform] ?? b.platform}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </PublicPage>
  );
}

/** The bio's own colours as a stylesheet, so the page needs no inline styles. The values are checked hex colours. */
export function bioCss(bio: Pick<BioRow, 'colors'>): string {
  const c = bioColors(bio);
  return `html:root:root:root{--bg:${c.background};--fg:${c.text};--ac:${c.accent};--at:${c.accent};--on:${c.buttonText};color-scheme:normal}\n`;
}

export { raw };
