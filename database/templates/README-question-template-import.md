# Canonical question workbook

`question-template-import.xlsx` is the canonical RUN-15 workbook. Generate it
with `npm run question-import-template:generate`; the committed artifact must
remain reproducible from that script.

The workbook contains three sheets:

- `README`: two-phase preview/commit instructions and prohibited workbook features.
- `Data Dictionary`: required columns and validation rules.
- `Questions`: the exact canonical header row. Users add data rows here only.

Stable identity uses `template_code`, `variant_code`, `category_code`,
`question_code`, and `clause_code`. Display labels and question text are content,
not keys. `supplier_scale` is `LARGE`, `SMALL`, or `ALL`; boolean fields are `1`
or `0`; scores are a slash-separated subset of `A/B/C/D/NA`.

Upload validates and records a preview batch without changing the target Draft.
Commit requires the one-time preview confirmation token, an idempotency key, and
the Draft's unchanged optimistic lock. Publishing is not part of import.
