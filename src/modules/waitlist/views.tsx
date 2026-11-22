/** The pages a visitor sees: sign-up form, personal status, leaderboard and short messages. */
import type { Child } from 'hono/jsx';
import type { Appearance } from '../../ui/appearance';
import { formatDate, formatNumber, plural } from '../../ui/format';
import { PublicButton, PublicCard, PublicField, PublicInput, PublicPage } from '../../ui/public';
import { referralLink } from './emails';
import type { Leader } from './queue';
import type { PersonView } from './signups';
import type { Question, Waitlist } from './types';
import { questionsOf } from './waitlists';

export const STYLES = ['/m/waitlist/waitlist.css'];

interface Frame {
  wl: Waitlist;
  look: Appearance;
}

export interface JoinPageProps extends Frame {
  count: number | null;
  token: string;
  preview: string;
  embed?: boolean;
  values?: Record<string, string>;
  errors?: Record<string, string>;
  notice?: string;
  /** Hidden fields that carry where the visitor came from. */
  carry: Record<string, string>;
  now: number;
}

function QuestionField({ q, value, error }: { q: Question; value: string; error?: string }) {
  const id = `a_${q.id}`;
  if (q.type === 'checkbox') {
    return (
      <div class="pub-field">
        <label class="wl-check">
          <input type="checkbox" id={id} name={id} value="yes" checked={value === 'yes'} required={q.required} />
          <span>{q.label}</span>
        </label>
        {error ? <span class="pub-error" role="alert">{error}</span> : null}
      </div>
    );
  }
  return (
    <PublicField id={id} label={q.label} optional={!q.required} error={error}>
      {q.type === 'longtext' ? (
        <textarea id={id} name={id} maxlength={1000} required={q.required}>{value}</textarea>
      ) : q.type === 'select' ? (
        <select id={id} name={id} required={q.required}>
          <option value="">Choose one</option>
          {q.options.map((o) => (
            <option value={o} selected={o === value}>{o}</option>
          ))}
        </select>
      ) : (
        <PublicInput id={id} value={value} maxlength={1000} required={q.required} invalid={Boolean(error)} />
      )}
    </PublicField>
  );
}

function opensIn(at: number, now: number): string {
  const days = Math.ceil((at - now) / 86_400_000);
  return days <= 1 ? 'Opens within a day' : `Opens in ${plural(days, 'day')}`;
}

export function JoinPage({ wl, look, count, token, preview, embed, values = {}, errors = {}, notice, carry, now }: JoinPageProps) {
  const closed = wl.status !== 'live' && !preview;
  const questions = questionsOf(wl);
  const countdown = wl.launch_at && wl.launch_at > now;
  return (
    <PublicPage title={wl.headline || wl.name} appearance={look} indexable={wl.status === 'live' && !embed} description={wl.description || undefined} styles={STYLES}>
      <div class={embed ? 'wl-embed' : undefined}>
        <PublicCard>
          {wl.image_url ? <img class="wl-hero" src={wl.image_url} alt="" loading="lazy" /> : null}
          <h1>{wl.headline || wl.name}</h1>
          {wl.description ? <p>{wl.description}</p> : null}
          {preview ? <p class="pub-note">Preview. Signups here are marked as test and left out of your numbers.</p> : null}
          {notice ? <p class="pub-note bad" role="alert">{notice}</p> : null}
          {closed ? (
            <p class="pub-note">{wl.status === 'draft' ? 'This waitlist is not open yet.' : 'This waitlist is not taking new signups right now.'}</p>
          ) : (
            <form method="post" action={`/w/${wl.slug}/join`} class="wl-form">
              <PublicField id="email" label="Email" error={errors.email}>
                <PublicInput id="email" type="email" value={values.email ?? ''} required autocomplete="email" inputmode="email" maxlength={254} invalid={Boolean(errors.email)} />
              </PublicField>
              <PublicField id="name" label="Name" optional>
                <PublicInput id="name" value={values.name ?? ''} autocomplete="name" maxlength={100} />
              </PublicField>
              {questions.map((q) => (
                <QuestionField q={q} value={values[`a_${q.id}`] ?? ''} error={errors[`a_${q.id}`]} />
              ))}
              <div class="wl-trap" aria-hidden="true">
                <label for="website">Leave this empty</label>
                <input id="website" name="website" tabindex={-1} autocomplete="off" />
              </div>
              <input type="hidden" name="t" value={token} />
              {preview ? <input type="hidden" name="p" value={preview} /> : null}
              {Object.entries(carry).map(([k, v]) => (v ? <input type="hidden" name={k} value={v} /> : null))}
              <PublicButton type="submit" block>{wl.button_text || 'Join the waitlist'}</PublicButton>
            </form>
          )}
          {countdown ? (
            <p class="wl-meta"><time datetime={new Date(wl.launch_at!).toISOString()}>{opensIn(wl.launch_at!, now)}</time>, on {formatDate(wl.launch_at!)}</p>
          ) : null}
          {wl.show_count && count && count > 0 ? <p class="wl-meta">{formatNumber(count)} {count === 1 ? 'person has' : 'people have'} joined</p> : null}
        </PublicCard>
        {wl.leaderboard_on && !embed ? (
          <p class="wl-links"><a href={`/w/${wl.slug}/leaderboard`}>Leaderboard</a> <a href={`/w/${wl.slug}/me`}>Find my link</a></p>
        ) : null}
      </div>
    </PublicPage>
  );
}

function Tiers({ view }: { view: PersonView }) {
  if (!view.tiers.length) return null;
  return (
    <ul class="wl-tiers">
      {view.tiers.map((t) => (
        <li class={t.reached ? 'done' : undefined}>
          <strong>{t.name}</strong>
          <span>{t.reached ? 'Reached' : `${plural(t.need, 'referral')}`}{t.reward ? `: ${t.reward}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

export function StatusPage({ wl, look, view, base, inviteUrl }: Frame & { view: PersonView; base: string; inviteUrl: string | null }) {
  const link = referralLink(base, wl, { code: view.referralCode });
  const heading =
    view.status === 'pending' ? 'Check your email' : view.status === 'review' ? 'We are checking your signup' : view.status === 'invited' ? 'You are invited' : view.status === 'accepted' ? 'You are in' : view.position ? `You are number ${formatNumber(view.position)}` : 'You are on the list';
  return (
    <PublicPage title={heading} appearance={look} styles={STYLES}>
      <PublicCard>
        <h1>{heading}</h1>
        {view.status === 'pending' ? <p>We sent a link to confirm your address. Your place is saved once you open it.</p> : null}
        {view.status === 'review' ? <p>Some signups are checked by hand. We will email you when yours is done.</p> : null}
        {view.status === 'active' && !view.verified ? <p class="pub-note">Your email is not confirmed. Referrals only count after the people you invite confirm theirs.</p> : null}
        {view.status === 'invited' && inviteUrl ? <PublicButton href={inviteUrl}>Claim your invite</PublicButton> : null}
        {view.status === 'active' || view.status === 'invited' || view.status === 'accepted' ? (
          <>
            <div class="pub-field">
              <label for="mylink">Your link to share</label>
              <input class="pub-input" id="mylink" readonly value={link} />
              <span class="pub-hint">{view.referrals === 0 ? 'Each friend who joins and confirms their email moves you up.' : `${plural(view.referrals, 'friend')} joined with your link.`}</span>
            </div>
            {view.next ? <p>{plural(view.next.remaining, 'more referral')} to reach {view.next.name}.</p> : null}
            <Tiers view={view} />
          </>
        ) : null}
      </PublicCard>
      {wl.leaderboard_on ? <p class="wl-links"><a href={`/w/${wl.slug}/leaderboard`}>Leaderboard</a></p> : null}
    </PublicPage>
  );
}

export function BoardPage({ wl, look, board }: Frame & { board: Leader[] }) {
  return (
    <PublicPage title="Leaderboard" appearance={look} styles={STYLES}>
      <PublicCard>
        <h1>Top referrers</h1>
        {board.length ? (
          <ol class="wl-board">
            {board.map((l) => (
              <li><span>{l.name}</span><strong>{formatNumber(l.referrals)}</strong></li>
            ))}
          </ol>
        ) : (
          <p>No one has referred a friend yet. Be the first.</p>
        )}
        <PublicButton href={`/w/${wl.slug}`} ghost>Back to {wl.name}</PublicButton>
      </PublicCard>
    </PublicPage>
  );
}

/** A short page with a heading, some text and an optional button or form. */
export function MessagePage({ look, title, children }: { look: Appearance; title: string; children?: Child }) {
  return (
    <PublicPage title={title} appearance={look} styles={STYLES}>
      <PublicCard>
        <h1>{title}</h1>
        {children}
      </PublicCard>
    </PublicPage>
  );
}

export function FindPage({ wl, look, sent }: Frame & { sent: boolean }) {
  return (
    <MessagePage look={look} title="Find your link">
      {sent ? (
        <p>If that address is on the list, we sent it your link. Check your inbox in a minute.</p>
      ) : (
        <form method="post" action={`/w/${wl.slug}/find`} class="wl-form">
          <PublicField id="email" label="Email"><PublicInput id="email" type="email" required autocomplete="email" maxlength={254} /></PublicField>
          <PublicButton type="submit" block>Send my link</PublicButton>
        </form>
      )}
    </MessagePage>
  );
}
