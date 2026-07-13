Write verified progress back to the Intake Spine Control Board.

1. Use `npm run board:step -- --id <step> --status <status> --notes <evidence>` to update a step.
2. Use `npm run board:complete -- --id <workstream-id> --summary <verification>` when the claimed
   workstream is finished.
3. A major milestone completes automatically when all required steps are complete.
4. Stop and reread shared state on `409`; never overwrite a newer update.
5. Never display or request Control Board credentials.
