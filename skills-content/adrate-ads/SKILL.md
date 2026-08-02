# AdRate Ads Operations Contract

Use this contract after `adrate-shared` for every M0 advertising task. M0 covers the hierarchy advertising account -> Campaign only. It does not read or write Adgroup or Ad objects.

## Select the TikTok authorization

Start by listing the advertiser and its authorization candidates:

```sh
adrate ads advertisers --json
```

Read `availableAuthorizations` and `authSelectionRequired`. When exactly one active authorization is valid, `--auth-id` may be omitted. When multiple candidates exist, choose one explicitly with `--auth-id`. If the task context cannot identify the intended authorization, present the safe candidates and ask the Owner once; never guess or silently select one.

## Inspect before changing state

For performance review, use a report to locate a Campaign, then retrieve fresh Current State before acting:

```sh
adrate ads report campaigns --adv-id 70001 --auth-id 42 --start-date 2026-07-01 --end-date 2026-07-31 --group-by day --page 1 --page-size 100 --json
adrate ads campaigns get --adv-id 70001 --campaign-id 80001 --auth-id 42 --json
```

Only after the Owner's ENABLE/DISABLE intent is unambiguous may you submit one Status command:

```sh
adrate ads campaigns status --adv-id 70001 --campaign-id 80001 --set disable --auth-id 42 --idempotency-key campaign_80001_disable_001 --json
```

Afterward, inspect the returned Command DTO. Query only when `isFinal=false`, and use the original selector:

```sh
adrate commands get --idempotency-key campaign_80001_disable_001 --json
```

Do not infer success from HTTP 202, HTTP 200, or a process exit code alone. Evaluate the Command `status` and `isFinal` fields using the recovery rules in `adrate-shared`.

## Keep both conversion-rate definitions explicit

- `conversionRate` is the click-based conversion rate: conversion count divided by destination-page click count. TikTok has announced that this metric's definition will change, so preserve the API value and label it explicitly as click-based.
- `conversionRateV2` is the impression-based conversion rate: conversion count divided by total impressions. It is the recommended CVR to display.
- Never mix the two rates, use one to validate the other, or shorten both labels to the same generic "conversion rate".

## Preserve values and reporting limits

Display `spend`, currency amounts, and ratio fields as their original strings so precision is not lost. `null` means N/A, never zero. Do not add monetary values across different currencies. Reports are delayed, can receive attribution backfill, and can be truncated. Read `meta.pagination` and fetch only the pages the task needs; do not automatically download everything or simply average row-level ratios.

## Keep Status server-owned

Status accepts only `--set enable` or `--set disable`, corresponding to ENABLE/DISABLE intent. The CLI must not send `currentStatus`, `automationType`, `before`, or `after`; the server obtains fresh state and computes those fields. Do not attempt to reproduce the state machine locally.

## M0 exclusions

Conditional recurring checks are rule automation and are not supported. Never build a polling loop that scans Campaigns and issues bulk writes.

M0 does not support DELETE, batch operations, budget changes, bid changes, creation, Adgroup writes, Ad writes, Copy, or GMV Max. Do not approximate these operations with Status commands or undocumented endpoints.
