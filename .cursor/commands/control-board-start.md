Register a CUE/FLEX workstream before editing.

1. Run `npm run board:status` and reconcile any conflict first.
2. Collect the chat/workstream name, feature branch, milestone, linked step, ownership area,
   repository-relative files, and a concise boundary summary.
3. Run `npm run board:start --` with those values.
4. Stop on a `409`; do not use a force flag or silently choose a new scope.
5. Never place credentials in the command or conversation.
