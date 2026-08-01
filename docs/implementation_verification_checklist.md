# Implementation Verification Checklist

## Automated gates

- npm test
- node --check public\app.js
- node --check server\index.js

## Regression areas

- Criteria import and variant filtering
- Supplier and ticket data
- Round 2 lock
- Correction workflow
- Rejection history
- Report context and export
- Scoring thresholds
- Migrations

## Manual UI gates

- #/suppliers
- #/evaluations
- #/approvals
- #/reports

## Status text gates

- Chờ khắc phục
