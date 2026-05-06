# Bisect Pair: R-Cl2 (`253998e`) + R-C3.1 (`1f3f1a9`)

**Issue**: commit `253998e` (R-Cl2 AlbumSync DTO finalization) does not compile in isolation.

**Root cause**: while in worktree, R-Cl2 silently absorbed R-C3.1's telemetry plumbing changes. The pair was committed as two logical commits but they form a logical unit.

**Workaround when bisecting**: skip to either `f20d19f` (after the pair) or before `253998e`. Do NOT bisect the gap between `253998e` and `1f3f1a9`.

**Suggested git tooling**: `git bisect skip 253998e^..1f3f1a9` if landing on either.
