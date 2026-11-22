# Audit log

The audit log is the record of who did what in your workspace, and when. Open it from Audit log in the sidebar.

## Who can use it

- Workspace owners and admins can read the log and download it.
- Members and viewers cannot open it.
- You only see entries from your own workspace. The owner of the whole install can also switch to Whole install, which adds sign-ins and other entries that belong to no workspace.

## Reading the list

- Newest entries come first. The time on the left is relative ("5 minutes ago"). Hover it to see the exact time, in UTC.
- Each row says who did it, what happened in plain words, what it was done to, and the IP address it came from.
- Select Details on a row to see everything stored about it. Some entries show the raw action code instead of a sentence when this version does not know the action yet.
- Select Load older entries at the bottom to go further back.

## Finding something

Use the bar above the list to search words, pick a person, pick an action, or set a start and end date. The filters stack. Select Clear filters to start over. The dates are in UTC and the end date includes the whole day.

## Downloading the log

Export CSV saves the entries that match your current filters as a spreadsheet file with the date in its name. It holds up to 10,000 entries, newest first. If there were more, a notice tells you the file stopped early; narrow the dates and export again. Every export is itself added to the log.

## How long entries are kept

Entries older than the retention setting are deleted each night. Choose 30 days, 90 days, 180 days, 1 year or Forever. Only the owner of the install can change it, and everyone else sees the current value. Changing it is recorded in the log.

## Limits

- Nobody can edit or delete an entry, including owners. Entries only go away when they pass the retention period.
- A longer retention period means a bigger database.
