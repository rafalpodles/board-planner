# Independent review

Independent means agents that did not write the change. Give each one the worktree path, a read-only rule, and the instruction to verify the premises (the ticket's claims, the fix's comments, "this is covered by") rather than accept them.

## Size it to the diff

| Diff | Review |
|------|--------|
| S/M ticket, one or two files, under about 50 lines | one reviewer, correctness and test honesty in the same brief. |
| Anything larger, multi-file, or touching auth, sessions, data integrity, workers | separate lenses: correctness and regression, integration with code the branch did not write, UX and accessibility, test quality, contract and degradation. Each lens gets an adversarial verifier whose job is to refute its findings; only survivors count. |

Test honesty: name the production mutation that turns each new test red, or it is decoration.

## Running reviewers

- Run reviewers so their verdicts reach you. A subagent that waits on its own background agents never resumes: their completion goes to the top-level session. When you are a subagent yourself, run reviewers in the foreground.
- Parallel reviewers share the worktree. One that mutates and reverts gets its own `git worktree add` off the branch, or runs alone.
- After every reviewer, finished or dead: `git status --porcelain`. A dead reviewer is not a review; relaunch it or say plainly it did not happen.
- Never `git add -A` after a review without reading the diff.
- For a security fix, review the resulting code, not the diff.

## The loop

1. Fix every bug the round found. Nits (style, naming, "could also") do not block; apply the ones worth it, say which you skipped.
2. A round that found a bug: send the delta to the same reviewers (SendMessage keeps their context), who read only the delta. A round that found nits only: the loop is over, no re-review of the nit fixes.
3. Repeat until a round returns zero bugs. Four lines of production code get at most two rounds in practice; more means the reviews are re-reading what they already accepted.
4. Then mutation-check every new test yourself (the red check in `e2e.md`).
5. A finding outside the task: fix it now when it belongs to the task; otherwise `create_task` in `todo` with file:line, after grepping `list_tasks` titles for a duplicate.

A bug is: wrong behaviour, a missing case, a security or data-integrity hole, a test that cannot fail, a comment or commit message claiming a property the code does not have.
