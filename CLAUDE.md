- This is a public open-source project — treat every commit as visible to the world.
- Before any git push, review the full diff for secrets, API keys, tokens, personal info, emails, or filesystem paths.
- Never hardcode Supabase URLs, keys, or any credentials — all config comes from user-provided values or env vars.
- Never include personal names, email addresses, usernames, or local paths in source code or comments.
- Never include references to internal, private, or proprietary systems, products, or codebases in tracked files.
- Never commit .env files, credential files, or config files containing secrets.
- Never leave informal comments, profanity, personal opinions, or "note to self" remarks in code.
- If unsure whether something is sensitive, ask before committing.

## Leak-prevention protocol (this repo is public — enforce every time)

- Run `gitleaks detect --no-git --redact` and confirm zero findings before every commit; never bypass it.
- Never run `git commit` or `git push` with `--no-verify` on this repo.
- Commit only files on the public allowlist: `.gitignore`, `CLAUDE.md`, `README*`, `LICENSE`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsup.config.ts`, `src/**`, `test/**`, `specs/**`, `.github/**`; anything else needs explicit human review first.
- Treat every AI-assistant-authored diff as elevated leak risk: assistants ingest the whole workspace (including gitignored files) and can regurgitate secrets, paths, or private wording — scan each AI change before staging.
- Keep all local strategy, notes, research, and handoff docs inside the gitignored `private/` folder; never enumerate their names in a tracked file.
- Never copy any content, wording, URL, or identifier from a `private/` file into any tracked file.
- The npm tarball ships `dist/` even though it is gitignored — run the leak scan over `dist/` before `npm publish`, not just over the git diff.
- Keep all real config in `kelo.config.json` (gitignored) and env vars; in tracked code use only placeholder hosts like `example.co`, never a real Supabase URL or key, even as an example.
- Enable GitHub secret-scanning Push Protection on the remote before the first push, as the backstop for anything that bypasses local hooks.

## Push & branch discipline (treat EVERY push religiously — no exceptions)

- This rigor applies to every single push, not just the first commit; never relax it because earlier pushes were clean.
- `main` is a PROTECTED branch: direct pushes and force-pushes are disabled on the remote — the ONLY way anything reaches `main` is a reviewed pull request.
- Never `git push` to `main` directly under any circumstances; for each change create a short-lived feature branch off `main`, open a PR, and delete the branch after it merges (GitHub Flow — no long-lived `dev` branch to keep in sync).
- Squash-merge PRs so each change lands on `main` as one clean commit; never let iteration/debugging commits reach `main`.
- Never `git commit` or `git push` (any branch) without explicit human approval for that specific action, every time.
- Before any push or PR merge, review the FULL diff line by line (human + AI together), exactly as the first commit was reviewed.
- Never force-push any shared branch; the only acceptable force-push was the one-time history cleanup, and `main` protection now forbids it entirely.
- Before pushing or opening a PR, state which branch and which commits will move, and wait for an explicit go-ahead.
