---
title: Context and compaction
description: What happens when a conversation outgrows the model's context window.
order: 3
---

Every model has a limit on how much conversation it can hold. When a chat
approaches it, Code Monet reclaims room in two passes, cheapest first.

## Pass one: clearing tool output, losslessly

Most of a long conversation is not conversation — it is tool OUTPUT. A 200KB
file read, a long grep, a build log. Those can be fetched again by calling the
tool, so old ones are replaced with a marker saying exactly that.

Nothing anyone said is touched, and no model call is made. If this alone brings
the chat under the limit, compaction stops here.

Results that cannot be re-obtained — a sub-agent's report, a question you
answered, a sandbox run with side effects — are never cleared. Neither are
errors: a cleared failure would read as a call that never happened.

## Pass two: summarising the old part

If clearing was not enough, the OLDER part of the conversation is summarised
while the most recent turns are kept word-for-word. What you are working on
right now is exactly what must stay exact.

## Manual control

The context indicator shows how full the window is. You can compact on demand,
and undo a compaction to restore the full history.
