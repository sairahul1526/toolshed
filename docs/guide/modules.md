# Modules

A module is one tool in Toolshed, such as short links or forms. Each workspace chooses which modules it uses. Open Modules in the sidebar, under Workspace, to see them all.

## What you see

Each card shows the module name, what it does, its category and whether it is On, Off or Needs setup.

- **On**: it is running and shows in the sidebar.
- **Off**: nothing runs and its public pages are closed.
- **Needs setup**: it is on, but something it depends on is missing. The card says what, and often links to where you fix it.

Use the search box to find a module by name or description. The All, On and Off tabs narrow the list. Both work without JavaScript.

## Turn a module on or off

Only workspace admins and owners can do this. Everyone else sees the same page, read-only, with a note to ask an admin.

1. Select Turn on on the module card.
2. To switch one off, select Turn off and confirm.

Turning a module off keeps your data. Public pages for this module stop working until you turn it back on. Turning it off in one workspace does not change any other workspace.

Every change is written to the audit log.

## Sample data

Some modules can add sample data so you can try them before using real records. Open the module, then use the Sample data card. The module must be on first. Removing sample data leaves anything you created yourself.

## The detail page

Select a module name to see its longer description, its status, the public paths it serves, and the permissions an API key can be given for it.

## If there are no modules

Modules are added when Toolshed is built and deployed. If you see "No modules are installed", add one to your build and deploy again.
