# Workspace settings

Open **Settings** in the dashboard menu. It has three tabs: General, Webhooks and Data. Owners and admins can change things. Everyone else can look at General and nothing else.

## General

Change the workspace **name** and its **address**, the short name people see in links. Changing the address breaks old bookmarks that use the old one. The address must be unique across this install. If it is taken, the form says so and keeps what you typed.

## Webhooks

A webhook sends a signed message to an https address when something happens in your workspace, so another service can react.

- **Add webhook**: give it a name, an https address and the events to send. Pick Everything, one tool's events or single events.
- **Signing secret**: shown once, straight after you add the webhook. Copy it then. Your receiver uses it to check a message came from you. You can show it again from the webhook's page while you are signed in.
- **Change** the name, address or events at any time. **Pause** stops sending, and events during a pause are not sent later. **Delete** removes the webhook and its delivery log.
- Toolshed turns a webhook off if it keeps failing for 72 hours. The page says why. Fix the receiver and press **Turn on**.
- A workspace can have up to 20 webhooks.

Custom headers, test sends and secret rotation are available through the REST API (`/api/v1/webhooks`), not on this screen.

## Data

- **Export everything** makes one ZIP with a JSON and a CSV file for every table. Passwords and key secrets are never in it. We email you when it is ready, and you can download it from the list for 24 hours. One export runs at a time.
- **Delete workspace** is for owners only. Type the workspace address to confirm. It removes everything in the workspace for good, and members lose access at once. Export first if you might want any of it. It needs a recent sign-in.

## Signed in as someone else

When an install owner is signed in as another person, they can rename the workspace and a webhook. They cannot export, delete, add, turn on or off, or see secrets.

## Who changed it

Renames, webhook changes, exports and downloads are written to the audit log.
