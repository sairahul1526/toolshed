# Updates

Updates shows what your install is running and walks you through updating it. Only the person who set up the install (the install owner) can open it. It is under Owner in the sidebar.

## What you see

- **Running now:** the Toolshed version, how many database changes have been applied, how many modules are installed, whether email is on, and whether any background jobs failed.
- **How to update:** the commands to run in a terminal, in order: save a copy of your data, get the new code, apply the database changes, deploy. Each command has a copy button. The last step is how to go back to the previous code if something looks wrong.
- **Database changes:** every change that has been applied to your database, and when. After an update, the newest ones should match the new version.
- **Modules:** every module this install ships, with its version.
- **Failed jobs:** background work that still failed after five tries, newest first.

## Why it does not update itself

Toolshed runs on your Cloudflare account and does not contact other sites, so it cannot look for new releases or deploy by itself. Watch the Toolshed repository for releases, then follow the steps on this page. Nothing changes until you run them.

## Retry a failed job

Press Retry on a row and confirm. The job goes back on the queue and runs again with a fresh set of tries. If it already did part of its work, such as sending an email, it may repeat that part. Retry is written to the audit log. A job that handled private details, or was too large to keep, shows "Can’t retry" and has to be started again from where it came from.

Failed jobs are kept for 30 days and then removed.

## Who can do what

- The install owner can open the page and retry jobs.
- Everyone else, including workspace owners and admins, sees "Only the owner of this install can open Updates."
