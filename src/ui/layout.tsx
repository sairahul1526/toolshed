/**
 * The three page frames: <Document> (the bare HTML page), <AuthLayout> (centred card for sign-in
 * and first-run pages) and <AppShell> (sidebar, top bar and content for the dashboard).
 * Screens rarely use these directly; `renderPage` and `renderAuthPage` in ./page.tsx wrap them.
 */
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { roleAtLeast } from '../env';
import type { ShellData, ShellNotifications } from '../core/shell-data';
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance, type PublicPreset } from './appearance';
import { Avatar } from './components/data';
import { Breadcrumb, Toast, type Crumb } from './components/feedback';
import { Icon } from './components/icon';
import { IconButton } from './components/buttons';
import { Menu } from './components/overlays';
import { cx } from './components/util';
import type { Flash } from './flash';
import { ICON_SPRITE } from './icons';
import { formatNumber, timeAgo } from './format';

export interface DocumentProps {
  /** Shown in the tab, after " · Toolshed". Leave empty for just "Toolshed". */
  title?: string;
  description?: string;
  appearance?: Appearance;
  /** Pins the colour mode (previews). People's own choice is ignored. */
  forceTheme?: 'light' | 'dark';
  /** Ignore the saved dashboard mode and follow the visitor's system setting (public pages). */
  lockTheme?: boolean;
  /** Public page look; sets `data-preset` on <html>. */
  preset?: PublicPreset;
  /** Extra class names for <body>. */
  bodyClass?: string;
  /** Adds a "do not index" tag. Dashboard and sign-in pages always set it. */
  noindex?: boolean;
  /** A one-time message, drawn as a toast. */
  flash?: Flash | null;
  /** Extra stylesheets (path under /assets), loaded after toolshed.css. */
  styles?: string[];
  /** Replaces toolshed.css, for pages that ship their own small stylesheet. */
  baseStyle?: string;
  /** Skip app.js on pages that need no scripting. */
  scripts?: boolean;
  /** Set `data-layout` on <body>, for tests and styling. */
  layout?: string;
  children?: Child;
}

/** The whole HTML document: head, theme, icon sprite, scripts. */
export function Document({
  title,
  description,
  appearance = DEFAULT_APPEARANCE,
  forceTheme,
  lockTheme,
  preset,
  bodyClass,
  noindex = true,
  flash,
  styles = [],
  baseStyle = '/assets/toolshed.css',
  scripts = true,
  layout,
  children,
}: DocumentProps) {
  const full = title ? `${title} · Toolshed` : 'Toolshed';
  return (
    <>
      {raw('<!doctype html>')}
      <html
        lang="en"
        data-accent={appearance.accent}
        data-mode={appearance.mode}
        data-theme={forceTheme}
        data-theme-lock={forceTheme || lockTheme ? '' : undefined}
        data-preset={preset}
      >
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{full}</title>
          {description ? <meta name="description" content={description} /> : null}
          {noindex ? <meta name="robots" content="noindex" /> : null}
          <meta name="color-scheme" content="light dark" />
          <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
          <script src="/assets/theme.js"></script>
          <link rel="stylesheet" href={baseStyle} />
          {styles.map((href) => (
            <link rel="stylesheet" href={href} />
          ))}
        </head>
        <body class={bodyClass} data-layout={layout}>
          {raw(ICON_SPRITE)}
          {children}
          <div class="toast-region" aria-live="polite">
            {flash ? <Toast message={flash.message} kind={flash.kind} /> : null}
          </div>
          {scripts ? <script src="/assets/app.js" defer></script> : null}
        </body>
      </html>
    </>
  );
}

export interface AuthLayoutProps extends Omit<DocumentProps, 'children' | 'layout' | 'bodyClass'> {
  /** The name above the card: the workspace name, or "Toolshed" before one exists. */
  brand?: string;
  /** Small print under the card. */
  footer?: Child;
  /** A wider card (invites, first-run setup). */
  wide?: boolean;
  children?: Child;
}

/** A centred card on a quiet page. Sign-in, invites, first-run setup. */
export function AuthLayout({ brand = 'Toolshed', footer, wide, children, ...doc }: AuthLayoutProps) {
  return (
    <Document {...doc} layout="auth">
      <main class="auth" id="main">
        <div class={cx('auth-wrap', wide && 'wide')}>
          <div class="auth-logo">
            <span class="logo-mark">
              <Icon name="shed" />
            </span>
            <span class="auth-brand">{brand}</span>
          </div>
          {children}
          {footer ? <p class="auth-foot">{footer}</p> : null}
        </div>
      </main>
    </Document>
  );
}

interface NavLink {
  href: string;
  icon: string;
  label: string;
  count?: number | null;
  dot?: 'warn' | 'accent';
  dotLabel?: string;
}
interface NavGroup {
  label?: string;
  add?: boolean;
  links: NavLink[];
}

/** The sidebar groups for this person. Exported so tests and the dev page can look at it. */
export function navGroups(shell: ShellData): NavGroup[] {
  const groups: NavGroup[] = [{ links: [{ href: '/app', icon: 'home', label: 'Overview' }] }];
  const mods: NavLink[] = shell.modules.map((m) => ({ href: m.href, icon: m.icon, label: m.name, count: m.count }));
  if (shell.modulesOff > 0) mods.push({ href: '/app/modules', icon: 'plus', label: 'Add a module', count: shell.modulesOff });
  groups.push({ label: 'Modules', add: true, links: mods });
  const admin = roleAtLeast(shell.org.role, 'admin');
  // Admins see their own workspace's email log and audit log, so those links live with the workspace.
  const shared: NavLink[] = [
    { href: '/app/email', icon: 'mail', label: 'Email' },
    { href: '/app/audit-log', icon: 'list', label: 'Audit log' },
  ];
  if (admin) {
    groups.push({
      label: 'Workspace',
      links: [
        { href: '/app/members', icon: 'users', label: 'Members' },
        { href: '/app/modules', icon: 'grid', label: 'Modules' },
        { href: '/app/appearance', icon: 'brush', label: 'Appearance' },
        { href: '/app/api-keys', icon: 'key', label: 'API keys' },
        ...shared,
        { href: '/app/settings', icon: 'gear', label: 'Settings' },
      ],
    });
  }
  if (shell.user.isInstanceOwner) {
    groups.push({
      label: 'Owner',
      links: [
        { href: '/app/users', icon: 'shield', label: 'Users' },
        ...(admin ? [] : shared),
        { href: '/app/updates', icon: 'refresh', label: 'Updates' },
      ],
    });
  }
  return groups;
}

function isActive(path: string, href: string): boolean {
  if (href === '/app') return path === '/app' || path === '/app/';
  return path === href || path.startsWith(`${href}/`);
}

/** The bell menu shows a taste of each notification, not all of it. */
function shorten(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/**
 * The bell. It is a plain link to the full list, so it works without JavaScript; app.js turns it into
 * the menu below it.
 */
function Bell({ notifications }: { notifications: ShellNotifications }) {
  const { unread, failed } = notifications;
  const label = unread > 0 ? `Notifications, ${formatNumber(unread)} new` : 'Notifications';
  return (
    <a class="icon-btn" href="/app/notifications" data-menu="notes" aria-label={label} title="Notifications">
      <Icon name="bell" />
      {unread > 0 && !failed ? <span class="dot" aria-hidden="true"></span> : null}
    </a>
  );
}

function BellMenu({ notifications, path }: { notifications: ShellNotifications; path: string }) {
  const { unread, latest, failed } = notifications;
  return (
    <form method="post" action="/app/notifications/read-all" data-no-busy>
      <input type="hidden" name="next" value={path} />
      <div class="menu menu-notes" id="menu-notes" role="menu">
        <div class="menu-head">
          <b>Notifications</b>
          {unread > 0 ? <span>{formatNumber(unread)} new</span> : null}
        </div>
        <hr />
        {failed ? (
          <p class="menu-empty">Notifications could not be loaded. Try again in a moment.</p>
        ) : latest.length === 0 ? (
          <p class="menu-empty">You are all caught up.</p>
        ) : (
          latest.map((n) => (
            <a href={`/app/notifications/${encodeURIComponent(n.id)}/open`} role="menuitem" class="note">
              <span class={n.read ? 'unread-dot off' : 'unread-dot'} aria-hidden="true"></span>
              <span class="row-text">
                <b>
                  {n.read ? null : <span class="sr-only">Unread: </span>}
                  {shorten(n.title, 80)}
                </b>
                {n.body ? <span>{shorten(n.body, 90)}</span> : null}
                <span>{timeAgo(n.at)}</span>
              </span>
            </a>
          ))
        )}
        <hr />
        {unread > 0 && !failed ? (
          <button type="submit" role="menuitem">
            <Icon name="check" />
            Mark all as read
          </button>
        ) : null}
        <a href="/app/notifications" role="menuitem">
          <Icon name="list" />
          See all
        </a>
      </div>
    </form>
  );
}

export interface AppShellProps extends Omit<DocumentProps, 'children' | 'layout' | 'bodyClass' | 'appearance'> {
  shell: ShellData;
  /** The URL path being shown, so the sidebar can mark the current page. */
  path: string;
  /** Parents of the page, after the workspace name. The last item is the page itself. */
  crumbs?: Crumb[];
  children?: Child;
}

/** The dashboard frame. */
export function AppShell({ shell, path, crumbs = [], children, ...doc }: AppShellProps) {
  const appearance = parseAppearance(shell.appearance);
  const groups = navGroups(shell);
  const bell = shell.notifications ?? { unread: 0, latest: [], failed: false };
  const trail: Crumb[] = [{ label: shell.org.name, href: '/app' }, ...crumbs];
  const roleLabel = shell.org.role.charAt(0).toUpperCase() + shell.org.role.slice(1);
  return (
    <Document {...doc} appearance={appearance} layout="app">
      <a class="skip" href="#main">
        Skip to content
      </a>
      <div class="app" id="app">
        <aside class="side" aria-label="Main">
          <div class="side-head">
            <a class="logo" href="/app">
              <span class="logo-mark">
                <Icon name="shed" />
              </span>
              <span class="hide-c">Toolshed</span>
            </a>
            <IconButton icon="panel" label="Collapse sidebar" class="collapse-btn" data-collapse aria-expanded="true" />
          </div>
          <button type="button" class="search" data-command title="Search (Ctrl or Cmd + K)">
            <Icon name="search" />
            <span class="hide-c search-text">Search</span>
            <kbd class="hide-c">Ctrl K</kbd>
          </button>
          <div class="side-scroll">
            {groups.map((g) => (
              <>
                {g.label ? (
                  <div class="group-label">
                    <span>{g.label}</span>
                    {g.add ? (
                      <a class="icon-btn" href="/app/modules" aria-label="Add a module" title="Add a module">
                        <Icon name="plus" />
                      </a>
                    ) : null}
                  </div>
                ) : null}
                <nav class="nav" aria-label={g.label ?? 'Overview'}>
                  {g.links.map((l) => (
                    <a href={l.href} aria-current={isActive(path, l.href) ? 'page' : undefined} title={l.label}>
                      <Icon name={l.icon} />
                      <span class="hide-c nav-label">{l.label}</span>
                      {l.count !== null && l.count !== undefined ? <span class="count hide-c">{formatNumber(l.count)}</span> : null}
                    </a>
                  ))}
                </nav>
              </>
            ))}
          </div>
        </aside>
        <div class="scrim" data-scrim></div>
        <div class="main">
          <header class="top">
            <IconButton icon="menu" label="Open menu" class="menu-btn" data-drawer />
            <Breadcrumb items={trail} />
            <div class="top-right">
              <button type="button" class="icon-btn" data-theme-btn aria-label="Dark mode" aria-pressed="false" title="Toggle dark mode">
                <Icon name="moon" class="i i-moon" />
                <Icon name="sun" class="i i-sun" />
              </button>
              <Bell notifications={bell} />
              <button type="button" class="me" aria-label="Account menu" data-menu="account">
                <Avatar name={shell.user.name || shell.user.email} src={shell.user.image} size="sm" />
                <span class="me-name">{shell.user.name || shell.user.email}</span>
                <Icon name="down" class="i muted" />
              </button>
            </div>
          </header>
          <main class="page" id="main" tabindex={-1}>
            {children}
          </main>
        </div>
      </div>
      <form method="post" action="/api/auth/sign-out" data-no-busy>
        <Menu
          id="account"
          head={{ title: shell.user.name || shell.user.email, subtitle: `${shell.user.email} · ${roleLabel}` }}
          items={[
            { label: 'Account', icon: 'user', href: '/app/account' },
            { label: 'Security', icon: 'shieldcheck', href: '/app/account?tab=security' },
            { label: 'Sessions and devices', icon: 'laptop', href: '/app/account?tab=sessions' },
            { label: 'Sign out', icon: 'logout', formAction: '/api/auth/sign-out', divider: true },
          ]}
        />
      </form>
      <BellMenu notifications={bell} path={path} />
      <dialog id="command" class="command" aria-label="Search">
        <div class="command-box">
          <Icon name="search" />
          <input type="search" placeholder="Go to…" aria-label="Go to a page" autocomplete="off" />
          <kbd>Esc</kbd>
        </div>
        <ul class="command-list" data-command-list></ul>
        <p class="command-empty" data-command-empty hidden>
          Nothing matches that.
        </p>
      </dialog>
    </Document>
  );
}
