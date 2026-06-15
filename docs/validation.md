# Validation Tiers

Use the fastest tier that covers the surface you changed. The named validation
scripts compose existing commands only; they do not update dependencies,
baselines, or generated assets.

| Command | Covers | Use when |
| --- | --- | --- |
| `npm run validate:build` | TypeScript and Vite production build. | Scripts, docs, or narrow code edits where simulation behavior is not affected. |
| `npm run validate:smoke` | Build, smoke simulation harness, and visual smoke screenshots. | Fast handoff check for targeted gameplay, debug, or validation-tooling edits. |
| `npm run validate:standard` | Build, standard simulation harness, and visual smoke screenshots. | Default local handoff for normal code changes before broad or shared review. |

Supporting commands remain available when a narrower check is more useful:

```bash
npm run test:sim:smoke
npm run test:sim:standard
npm run test:sim:full
npm run test:sim:paranoid
npm run screenshots:smoke
npm run screenshots:full
```

Screenshot commands compare against durable baselines in `test/baselines/visual`
and write actual and diff images under `.sim-build/screenshots`. The smoke set
covers both authored cavern views and water-focused gameplay closeups for
reservoir drops, basin shorelines, tunnel contact, and hazard flow. They expect a local
Chrome-compatible binary named `google-chrome`; set `CHROME_BIN` when the binary
has another name.

Only run `npm run screenshots:update` or `npm run screenshots:update:smoke` when
the expected visual output changed and the baseline PNGs are intentionally in
scope for the task.

`npm run test:sim:full` keeps periodic water-integrity scans so it remains usable
as a pre-push check. `npm run test:sim:paranoid` scans every tick and is reserved
for deep solver debugging because it can be much slower on the generated cavern.
