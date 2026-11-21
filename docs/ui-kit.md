# UI kit

Server-rendered Hono JSX components, one stylesheet and two small scripts. No client framework, no build step for the UI, no third-party requests.

```tsx
import { Button, Card, PageHeader, Table, renderPage } from '../../ui';

export default async function screen(c: Context<AppEnv>) {
  return renderPage(c, { title: 'Links', crumbs: [{ label: 'Links' }] }, (
    <>
      <PageHeader title="Links" actions={<Button variant="primary" icon="plus">New link</Button>} />
      <Card flush><Table caption="Links" columns={[...]} rows={[...]} /></Card>
    </>
  ));
}
```

Run `npm run dev` and open `/dev/ui` to see every component. Add `?theme=dark`, `?accent=violet` or `?data=worst` (long names, huge numbers, empty lists, other scripts). Also `/dev/ui/auth`, `/dev/ui/public?preset=warm` and `/dev/ui/error?status=404`. These routes only exist in dev.

## Pages

| Helper | Use |
| --- | --- |
| `renderPage(c, { title, crumbs?, status?, description? }, body)` | A dashboard screen inside the shell. Builds the nav from the signed-in user, role and enabled modules, shows and clears any flash message, sets `cache-control: no-store`. |
| `renderAuthPage(c, { title, brand?, footer?, wide?, status? }, body)` | Sign-in, invite and setup pages. Centered card, no nav. |
| `PublicPage` | Pages the public sees (forms, short-link previews). Uses `public.css`, no dashboard styles or scripts. |
| `ErrorPage` | 404 and other errors outside the API. |
| `setFlash(c, { kind, message })` | In a POST handler before redirecting. The next `renderPage` shows it as a toast. |

Lower level: `Document`, `AuthLayout`, `AppShell` in `layout.tsx` when you need full control.

## Components

All are exported from `src/ui/index.ts`.

- Buttons: `Button`, `LinkButton`, `IconButton`. Variants `default`, `primary`, `danger`, `danger-solid`, `ghost`. A submitted form shows a busy state on its button automatically; add `data-no-busy` to the form to skip it.
- Forms: `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioCards`, `Segmented`, `OtpInput`, `PasswordInput`. Pass `invalid` and `Field error="..."` together. Radio and checkbox controls are native, so forms work without JavaScript.
- Data: `Card`, `PageHeader`, `Section`, `Stat`, `StatGrid`, `Table`, `Pagination`, `Pill`, `Avatar`, `EmptyState`, `Callout`, `Tabs`, `KeyValueList`. Tables turn into cards at 760 px and below, so give every column a short `label`.
- Overlays: `Dialog`, `ConfirmButton` (inside a form), `Menu`, `Inspector`, `CopyField`, `CodeBlock`, `DangerZone`, `FilterBar` and `SearchInput` (a GET form, so filters live in the URL).
- Feedback: `Skeleton`, `Toast`, `Breadcrumb`, `EditorBar`.
- Charts: `BarChart`, `LineChart`, `Sparkline`. SVG with a hidden data table for screen readers. Charts are drawn from the values you pass, never from user HTML.
- Helpers: `formatNumber`, `formatCompact`, `formatDate`, `formatDateTime`, `timeAgo`, `formatBytes`, `plural`, `initials`. Dates are always UTC.

## Opening things from markup

No inline handlers (the CSP forbids them). `app.js` reads data attributes:

| Attribute | Effect |
| --- | --- |
| `data-open="id"` / `data-close` | Open or close a `<dialog>` |
| `data-menu="id"` | Toggle `#menu-id` (arrow keys work) |
| `data-inspect="id"` | Open the side inspector |
| `data-copy="text"` | Copy to clipboard, button shows `data-copied` |
| `data-toast="message"` | Show a toast on click |
| `data-theme-btn`, `data-collapse`, `data-drawer` | Theme toggle, sidebar collapse, mobile drawer |

Tabs, the OTP field, password toggle and Ctrl or Cmd + K command menu need no setup. `window.Toolshed.toast(message, kind)` is available to scripts.

## Appearance

A workspace saves `mode` (system, light, dark), `accent` (lime, mint, sky, violet, rose, amber) and a public `preset` (paper, warm, cobalt, dusk). `parseAppearance` turns any saved value into a valid one. `theme.js` is a tiny blocking script so the right theme is on screen before first paint; people can override the mode per device and it is remembered.

## Rules for new screens

- Sentence case, no exclamation marks or emoji, say "workspace".
- Every icon-only button needs a `label`. Every table needs a `caption`.
- No inline styles or `on*` attributes. Put new CSS in `public/assets/toolshed.css` using the existing tokens.
- Check the screen at 375 px and with `?data=worst` style data before shipping.

## Files

```
public/assets/toolshed.css   dashboard styles and tokens
public/assets/public.css     small standalone sheet for public pages (under 12 KB)
public/assets/theme.js       blocking, applies theme and sidebar state
public/assets/app.js         deferred behaviour, loaded by the shell
src/ui/                      components, layouts, helpers, dev gallery
test/ui/                     unit tests; test/e2e/ui.e2e.ts covers behaviour, contrast and overflow
```
