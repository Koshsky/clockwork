# Contributing

Create short-lived branches from the latest main and open pull requests into main:

```sh
git fetch origin
git switch main
git pull --ff-only
git switch -c feature/short-description
```

Use feature/*, fix/*, chore/* or another descriptive topic name. Delete the branch
after merging. Read AGENTS.md and run the affected service checks. Both services
share a repository, but retain separate versions and Docker artifacts.

Do not edit generated clients, published migration SQL or published release notes
manually. Building or pushing a change does not deploy a server.
