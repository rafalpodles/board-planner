# How the app runs for Trawler in CI

Trawler reads this file when it plans what to test for a pull request. It describes the app that `.github/trawler/start-app.sh` starts in the job; a change that needs something this setup lacks cannot be seen by anyone Trawler sends in.

## The setup
- A single self-hosted instance built from the pull request's commit with `docker compose`, on an empty database. There is no `ORGANISATION_DOMAIN`, so there are no organisations on subdomains, no plan (Free or Pro), no trial, no licence and no member limit.
- One account exists: the administrator "Trawler Demo". Both people Trawler plays (Maya and Daniel) sign in with that same account, so two roles are not two users. A pull request about sign-up, invitations or permissions makes Trawler go through the real flow instead.
- There are no projects or boards at the start ("0 projects"). Anything a person needs has to be created in the session first.
- Accounts are created by an administrator or by an invitation. There is no self sign-up page, and that is intended.

## What is switched off
- No mail server: an invitation is not mailed, the app shows its link to the person who sent it.
- No AI key on the server (`OPENROUTER_API_KEY` is empty): the PM agent, AI Assist and task generation cannot produce a result. Screens that say the key is missing are expected.
- GitHub sync is off, and the PM scheduler and the digest tick once a day, so they never fire inside a job.

## Limits of the people Trawler sends in
- They cannot type into a password-type input except on the sign-in form, so a key or secret field cannot be filled in.
- They only use the browser; they cannot reach the database, the licence service or the command line.
