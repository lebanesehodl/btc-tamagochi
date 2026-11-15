# Provider fixtures, not consensus proofs

`backward-timestamps.json` contains the JSON metadata responses for adjacent mainnet blocks, captured via HTTPS on 2026-11-15. Their order in this fixture is ascending **height**, not timestamp.

- 975858: https://blockstream.info/api/block/00000000000000000000fa59a3ba9fcb5f3e26319304442c374bb953c8b9f93f
- 975859: https://blockstream.info/api/block/00000000000000000000bc788faec10435219c4ab79b205fbbe20dd29d053310

975859's `previousblockhash` equals 975858's `id`. The child's timestamp (`1794699426`) is 159 seconds earlier than its parent's (`1794699585`). The application must accept the sequence and produce one new meal when advancing from the parent, then none when observing that same tip again.

These are provider-reported API fixtures. They do not independently establish valid proof of work, chainwork, consensus validity, or the best chain. The other test chains are deliberately synthetic metadata, not mined blocks.

Endpoint contract: https://github.com/Blockstream/esplora/blob/master/API.md#blocks
