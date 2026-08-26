# Pushing to `qa` — team workflow

The `qa` branch is a **shared branch**: everyone pushes to it directly, and every
push auto-deploys to the QA environment (https://finix.vgipl.com:8445) via the
**Deploy to QA** GitHub Actions workflow.

Because it's shared, the #1 cause of a failed push is a **non-fast-forward
rejection** — your local branch is behind `origin/qa` because a teammate pushed
first. This is a sync problem, not a permissions problem. Here's how to never hit
it.

## One-time setup (run once per machine)

```bash
git config --global pull.rebase true      # pull = replay your commits on top of latest
git config --global rebase.autoStash true # auto-stash uncommitted work during a pull
git config --global fetch.prune true      # drop deleted remote branches on fetch
```

Optional — if your local branch is called something other than `qa` (e.g.
`qa-local`), simplify so a plain `git push` just works:

```bash
git checkout qa
git branch --set-upstream-to=origin/qa qa
```

## Every time you push

**Always sync before you push:**

```bash
git add <files>
git commit -m "your message"
git pull        # rebases your commit on top of the latest qa (thanks to config above)
git push        # now a clean fast-forward — no rejection
```

If two teammates push within the same minute, `git pull` will simply rebase your
commit again — repeat `git pull` then `git push`. That's normal, not an error.

### If you see `! [rejected] ... (non-fast-forward)`

You pushed without syncing. Fix:

```bash
git pull        # (rebase; resolve conflicts if any, then `git rebase --continue`)
git push
```

## What happens after you push

The deploy runs on the QA server in this order (a failure at any step aborts and
leaves the **old** build serving — QA never goes down from a bad push):

1. Pull `qa` on the server
2. Install any new Python deps
3. **Build the frontend** — if this fails, deploy aborts here (DB untouched)
4. Migrate the QA database
5. Restart QA services
6. Health check

If your push fails the **Deploy to QA** run, open the run, read the failing step,
fix, and push again. A red run means it did **not** deploy — the previous good
build is still live.

## Golden rules

- `git pull` before every `git push`. Always.
- A red **Deploy to QA** = not deployed; the fix is another push, not a retry.
- Don't force-push `qa` — it can erase a teammate's work. If you think you need
  to, ask first.
