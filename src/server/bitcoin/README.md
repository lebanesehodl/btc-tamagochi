# Bitcoin module ownership

Owned by Bitcoin for the web-MVP task. Other agents must not edit this directory or `src/shared/bitcoin.ts` without coordinating in the Buzz thread.

Implement the provider adapter, reproducible generic pantry rotation, active-chain reconciliation helpers, and focused tests/fixtures here. Keep provider metadata separate from consensus validity. Never sort the chain by timestamp or require block timestamps to increase.

Do not modify `package.json`, CI, deployment files, world/UI files, or BWATCH.
