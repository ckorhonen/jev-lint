# The feedback loop: teach your agents to stop repeating mistakes

jev-lint doesn't just catch problems. It keeps a record of every one, so you can find the
mistakes your agents keep making and fix the cause: a missing line in `AGENTS.md`, a skill
that teaches the wrong pattern, or a rule that nags about code that's actually fine.

## For humans: how it works

1. **Every check is logged, locally.** Each time the hook checks an edit, it appends one line
   to `~/.local/state/jev-lint/findings.jsonl`: the repo, the file, which rules fired, and a
   short excerpt. Nothing leaves your machine (except the check itself, which goes to Jev).
2. **Each finding gets an outcome.** If the agent's next edit to that file clears the flag, it
   counts as **fixed**: the agent made the mistake and corrected it. If the flag is still
   there at the end, it counts as **kept**: the agent disagreed or ignored it, so the rule may
   be wrong for your code. At the end of every turn, a small **re-check hook** looks again at
   any file that still had findings, asking only those rules about the file as it is now, so
   every finding gets an outcome even if the agent never touched the file again. (Subagents
   are tracked separately, so one subagent's fix doesn't count for another's file.)
3. **Every week or two, an agent reviews the log.** It groups findings into clusters (rule ×
   part of the repo × test or not). It only acts on clusters with real evidence: at least
   5 outcomes across at least 3 sessions. Then it proposes up to three changes:
   - agents keep making and fixing the same mistake → **add guidance** to `AGENTS.md` or a skill;
   - agents keep ignoring a rule, and the code is fine → **narrow the rule** or skip it for that folder;
   - reviewers keep catching something the hook doesn't → **write a new rule**.
4. **Each change is proven before it's kept.** The rule changes are checked against labeled
   examples. The instruction changes are checked by having an agent do a few small tasks
   twice: once with the old instructions, once with the new. If the new ones don't reduce
   the mistake, the change is dropped. See [Proving a change](#proving-a-change) below.
5. **Then it's measured in real use.** Two weeks later, the log shows whether the mistake
   actually became rarer (`findings.ts --compare`, with a confidence interval).

You stay in control. The scheduled agent writes a report and a branch; you review and merge.

## For agents: set it up

Do these steps in the repo you're setting up. Ask the user before creating the scheduled job,
and show them the exact command it will run.

### 0. Make sure the re-check hook is installed

`bun ~/Repos/jev-lint/src/install.ts` (a dry run) should report the re-check on `Stop` and
`SubagentStop` for each agent. If it says "added (dry run)", run it again with `--apply`.
Without it, most findings end up "unknown" and the loop has little evidence to work with.
Turn it off with `--no-recheck` at install time or `JEV_LINT_RECHECK=off`.

### 1. Make sure there's something to learn from

```sh
bun ~/Repos/jev-lint/src/findings.ts --repo . --days 30
```

If there are fewer than about 5 sessions or 100 checks, tell the user the loop needs a week or
two of use first. The schedule can still be set up now.

### 2. Add the eval scaffolding to the repo

```
.jev-lint/
  cases.jsonl          # labeled snippets: proves a rule still judges correctly (validate.ts)
  evals/               # small agent tasks: proves an instruction change helps (repoEval.ts)
    <task>.json
  reports/             # the loop's weekly reports (commit them, or gitignore them)
```

An eval task is a prompt that tends to trigger the mistake, plus the rules that detect it:

```json
{
  "prompt": "Add an endpoint GET /projects/:id/invoices that returns the project's invoices as JSON.",
  "rules": ["repo-no-direct-db-in-routes", "ts-sec-unscoped-record-lookup"],
  "reps": 3
}
```

Write tasks from real clusters in the findings log. The task should ask for the kind of change
where the mistake happened, without mentioning the rule. Keep each task small: one feature,
one or two files. That keeps runs cheap and the signal clear.

### 3. Schedule the review

The findings log lives on the developer's machine, so run the review locally, weekly. Use the
agent the user already uses. It runs headless in a separate git worktree, so it never touches
their working copy.

**Claude Code** (macOS launchd or cron; this is the command it runs):

```sh
cd <repo> && git worktree add -f ../<repo>-jev-lint-learn origin/main 2>/dev/null; cd ../<repo>-jev-lint-learn && git pull -q --ff-only &&
claude -p "Use the jev-lint-learn skill on this repo for the last 14 days. Write your report to .jev-lint/reports/$(date +%F).md. If a change qualifies, make it on a new branch jev-lint/learn-$(date +%F), prove it with repoEval.ts or validate.ts as the skill says, commit, and push the branch. Never merge." \
  --permission-mode acceptEdits
```

**Codex:**

```sh
codex exec -s workspace-write "Use the jev-lint-learn skill on this repo … (same prompt)"
```

On macOS, a `launchd` agent is more reliable than cron for laptops (it runs missed jobs after
sleep). Write `~/Library/LaunchAgents/dev.jevlint.learn.<repo>.plist` with a `StartCalendarInterval`
(e.g. Monday 09:00), `ProgramArguments` = `["/bin/zsh", "-lc", "<the command above>"]` and
`StandardOutPath` in `~/.local/state/jev-lint/`. Load it with
`launchctl bootstrap gui/$(id -u) <plist>`. On Linux, a crontab line such as
`0 9 * * 1 /bin/zsh -lc '<command>'` works.

If the team uses a hosted scheduler instead (e.g. a cloud agent), note that it can't see the
local findings log. It can still run the evals and the rule validation.

### 4. What the scheduled run must never do

- Merge its own branch, or push to the main branch.
- Change anything based on fewer than 5 outcomes across 3 sessions.
- Make more than three changes per run.
- Copy excerpts from the findings log into PR descriptions, issues or anything outside the repo
  (they're code).
- Edit built-in rules (they live in the jev-lint repo). Use `.jev-lint/config.json`
  (`disable`, `skipPaths`) or a repo rule instead.

## Proving a change

**A rule change** (reworded, narrowed, new):

```sh
bun ~/Repos/jev-lint/src/validate.ts .jev-lint      # every rule must come back "keep"
```

**An instruction or skill change** (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/…`):

```sh
bun ~/Repos/jev-lint/src/repoEval.ts --base HEAD --reps 3
```

This runs every task in `.jev-lint/evals/` twice, alternating the order:
- **base:** a clean copy of `HEAD`;
- **change:** a copy of your working tree, with the proposed edit.

The jev-lint hook is off in both runs, so the instructions are the only difference. Jev
then checks the code the agent wrote against each task's rules. You get the number of
violations per run for each side, the difference, a 95% confidence interval and a verdict:

- **change helps:** the whole interval is below zero. Keep it.
- **no clear difference:** keep the change only if it's small and clearly correct; otherwise drop it.
- **change hurts:** drop it.

Each agent run costs roughly what one small task costs you normally (cents, a minute or two),
so `--reps 3` over three tasks is 18 runs. Save the result files under
`.jev-lint/evals/results/` and link them in the report.

## Related

- The `jev-lint-learn` skill: the full procedure the scheduled agent follows.
- The `jev-lint-write-rule` skill: writing and testing a new rule.
- `bun ~/Repos/jev-lint/src/findings.ts --help`: the log, clusters and `--compare`.
