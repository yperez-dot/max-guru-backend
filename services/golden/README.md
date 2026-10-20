# Golden scenarios

End-to-end checks built from real Max chats. Each `scenarios/*.json` file is one case:
the saved workup, her exact messages, and stubbed carrier/formulary lookups (no network). The runner (`golden.test.js`)
pushes them through the same code the live chat and the compare card use and checks:

- **plans / gridPlans**: the plan set and the grid columns (`[...]` = exact order, or `{ include, exclude }`)
- **doctors**: the doctor set, plus `cells` (In/Out per plan), `gridRows` and `followUpIncludes` (questions belong in the follow-up bubble)
- **meds**: the med set, plus `medCells`
- **live chat** (`serverReruns`, `chatGridPlans`, `chatFollowUpIncludes`, `chatExcludes`): the chat server re-runs the
  comparison itself for her message (no model answering from its old table), the chat grid's columns in order, and
  what the chat's follow-up bubble must / must not say
- **notFound** doctor stubs: `{ "notFound": [{ name, specialty, city, npi, spelling }] }` — no NPI match, with near-matches
- **layout rules** (always on): no "Why these plans" / "Excluded:" / "cost same across strengths"; no question in the
  grid bubble; the card's Plans line equals the grid columns
- **doctorNames / medNames**: the doctor-name normalizer (export name, search query, particle variants, org) and the
  med-name normalizer (medicare.gov naming, with stubbed RxNorm answers)

## Add a case from a pasted chat

```
node scripts/golden-from-chat.js chat.txt > services/golden/scenarios/<client>-<what>.json
```

Lines starting with `You:` / `Me:` are hers and `Max:` is Max. A pasted saved-workup banner becomes the workup (or pass
`--workup saved.json`). Max's newest doctor grid and meds table become the stubbed lookups. `expect` is a snapshot of
what the code does now, so fix anything wrong, delete the `review` line, then run:

```
node --test services/golden/golden.test.js
```

Use anonymized client names (for example "Katy client 1"). Doctor names, NPIs and plan IDs stay as they are.
