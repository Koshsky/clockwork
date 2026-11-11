# Contributing

`main` is the only permanent branch. Start each change from the latest main:

```sh
git fetch origin
git switch main
git pull --ff-only
git switch -c feature/short-description
```

Use a short-lived `feature/*`, `fix/*`, `chore/*`, or another descriptive topic
branch. Push it and open a pull request targeting `main`. Keep changes focused,
run the checks documented in AGENTS.md, and merge only after required checks pass.
Delete the topic branch after merging; do not recreate `dev` or `staging`.

Release tags are immutable. Record the version in both changelogs before building
and publishing a release. Docker tags such as `staging` describe deployment
artifacts and do not require a matching Git branch. Publishing an image does not
automatically deploy it to a server.
