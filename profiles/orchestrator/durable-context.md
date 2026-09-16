# Standing rules

## Test credentials

- Test logins live in `~/.<project>/test-creds.json` (directory `700`, file `600`).
  That file never enters a repository, a commit, a screenshot, or a subagent
  prompt.
- A login may be named. A password is never printed, echoed, quoted back, put in
  a report, a Jira comment, or a caption — not even partially, not even to
  confirm it.
- Edit that file with a script that reads and writes the JSON. Do not open it
  into the transcript, so other entries' passwords stay out of context.
- Production credentials are never used, and PROD is out of scope for
  reproducing a bug. Test and stage only.
- Pick the entry by its `note` field: screens are role-gated, so the wrong
  user silently cannot reach the one under test.

## Jira and Bitbucket

- Posting a comment, reassigning, or editing a ticket happens only after the
  exact text has been shown and approved in that same turn.
- Never transition a ticket's status unless that specific transition was asked
  for.

## Reporting

- When a check was skipped, blocked, or cost-limited, say so in the same breath
  as the result. A gap that is stated is useful; a gap that is implied is not.
