# Get started

Get started is the page a new workspace lands on after setup. It lives at `/app/welcome` and sits at the top of the sidebar, with a count such as 2/6, until every step is done.

Only workspace admins and owners see it. Members and viewers are sent to Overview.

## What first?

One card per module that has a first thing to do, for example "Shorten a link". Selecting a card turns that module on for this workspace and opens it. If the sample data switch is on and the module has sample data, the module opens with a few example rows.

A module that is already on shows an **On** label, and its card only opens the module.

The last card, "See all modules", opens the full list on [Modules](modules.md).

## Finish setting up

A step is ticked only when the thing is really there. Nothing is stored per step, so the list cannot go out of date.

| Step | Ticked when |
|---|---|
| Claim this Toolshed | Always, for the person who claimed the install. Other admins do not see this step |
| Name your workspace | Always. Rename opens Settings |
| Verify a sending domain | Email can go out. On a local dev install, emails saved to the outbox count |
| Invite a teammate | The workspace has more than one person |
| Turn on a module | At least one module is on |
| Add a passkey | Your own account has a passkey |

The passkey step is about your account, so two admins can see different counts.

**Hide from sidebar** removes the entry for everyone in the workspace. The page stays at `/app/welcome`, and **Show in sidebar** on that page puts it back. The entry also goes away by itself when every step is done.

## Sample data

The switch decides whether modules you start from this page come with example rows.

- Turning it **off** removes the sample rows from every module that has them. Your own rows are not touched.
- Turning it **on** only changes what the cards do from then on. It does not add rows to a module you already use.

You can also add or remove sample data for one module from its page on Modules.

## This install

The version that is running, the address, and how large the database is. The install owner also gets a link to [Updates](updates.md). The database line is left out when the size cannot be read.

## Audit log

Starting a module here writes `module.enabled`. The switch writes `onboarding.sample_on` or `onboarding.sample_off`. Hiding and showing the sidebar entry write `onboarding.hidden` and `onboarding.shown`.
