# AdRate Ads Operations Contract

Use this contract after `adrate-shared` for every AdRate CLI advertising task. Work only at the advertising account -> Campaign level, through Campaign Copy, or through automation rules. Do not perform independent Adgroup or Ad read/write operations.

## Select the TikTok authorization

Start by listing the advertiser and its authorization candidates:

```sh
adrate ads advertisers --json
```

Read `availableAuthorizations` and `authSelectionRequired`. When exactly one active authorization is valid, `--auth-id` may be omitted. When multiple candidates exist, choose one explicitly with `--auth-id`. If the task context cannot identify the intended authorization, present the safe candidates and ask the Owner once; never guess or silently select one.

## Discover a GMV Max Campaign

Never guess a GMV Max store or Campaign binding. Resolve the store and Campaign IDs from fresh data:

```sh
adrate gmvmax stores --adv-id 70001 --auth-id 42 --json
adrate gmvmax campaigns list --adv-id 70001 --store-id shop-1 --promotion-type product --auth-id 42 --json
```

Use `gmvmax campaigns get` when the task needs fresh details for one selected Campaign:

```sh
adrate gmvmax campaigns get --adv-id 70001 --campaign-id 80001 --store-id shop-1 --auth-id 42 --json
```

`--promotion-type` accepts only `product` or `live`. `--from` and `--to` may narrow the list to one inclusive window of at most 30 days and must be supplied together. `--include-trend` adds the daily trend to the response; it does not avoid an upstream report call. The Campaign list is a bounded server-side aggregation: inspect `truncated` and `warning`, and never treat a partial result as complete. Reads may omit `--auth-id` only when the server has exactly one valid candidate. Every GMV Max Campaign status, budget, or ROAS write requires an explicit `--auth-id`.

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

## Adjust Campaign budget

Budget adjustment follows the same Command model as Status: persist intent locally, send at most one POST, and recover from exit 5 via `commands get/pending/resume`.

Modes: `set` (absolute value), `increase_amount`, `decrease_amount`, `increase_percent`, `decrease_percent`. Relative adjustments (increase/decrease) are applied exactly once: the target budget is locked server-side after the first GET and never recalculated on retry or resume with the same idempotency key.

```sh
adrate ads campaigns budget --adv-id 70001 --campaign-id 80001 --mode set --value 300 --auth-id 42 --idempotency-key campaign_80001_budget_300 --json
adrate ads campaigns budget --adv-id 70001 --campaign-id 80001 --mode increase_percent --value 20 --auth-id 42 --idempotency-key campaign_80001_incr20pct --json
```

The value must be a positive number with at most two decimal places. The server enforces the budget ceiling and budget_mode eligibility; TikTok validates the account-currency minimum. Campaigns with infinite or missing adjustable budget are rejected with `BUDGET_NOT_ADJUSTABLE`. SPC Campaign budget changes are rejected with `SPC_CAMPAIGN_NOT_SUPPORTED` and must be completed through the AdRate Web interface.

## Copy Campaigns through an asynchronous task

Prepare one JSON file and keep copied Campaigns disabled by default. The server defaults `options.operationStatus` to `DISABLE`; tell the Owner that the copies will be disabled. Set it to `ENABLE` only after the Owner explicitly requests that outcome.

Preview before submitting:

```sh
adrate ads copy preview --file copy.json --json
```

Remove each Campaign reported in `unsupported` or with `perCampaign[].oversized=true`, then preview the corrected file again. Submit the same reviewed file. Preview is shallow advice: an empty `unsupported` array and absent or false `oversized` fields do not guarantee submit acceptance or Worker success.

`oversized` is computed from a lower-bound estimate of the upstream calls submit will make. It does not include ACO material lookups, ENGAGEMENT backfill, or transport retries, so `oversized: false` does not rule out a submit that exhausts its upstream budget. Treat it as "this file is already too large" when true, never as "this file will fit" when false. A budget exhaustion happens before any task is created, so it is safe to reduce the file and submit again.

```sh
adrate ads copy submit --file copy.json --idempotency-key copy-20260808-1 --json
```

Exit 0 means only that the Copy task was accepted, not completed. There is no `--wait` mode. Read the returned `taskId`, then query it every 30 seconds for at most 10 minutes:

```sh
adrate ads copy tasks get --task-id 42 --json
```

Stop on `completed`, `failed`, or `partial`. If the limit expires while the task is still processing, report that it remains in progress. For `partial`, report every target item with its `targetAdvId`, item `status`, `error`, and `resultData`; within `resultData`, include each Campaign and Adgroup result and warning instead of summarizing the task as completed.

Use the bare tasks command to read one list page; never add a `list` subcommand:

```sh
adrate ads copy tasks --status partial --page 1 --page-size 20 --json
```

Campaign Copy submit uses a receipt, not a Command journal. On a network failure, timeout, invalid response, or lost response, replay the original file unchanged with the original idempotency key. An explicit `INVALID_REQUEST`, `DAILY_QUOTA_EXCEEDED`, or `PLAN_LIMIT_EXCEEDED` rejection proves that no Copy task was accepted; correct the validation or quota issue and submit the corrected file with a new key. `commands get`, `commands pending`, and `commands resume` do not recover Copy submit.

## Change one GMV Max Campaign

After resolving the target from fresh store and Campaign data, submit at most one status, budget, or ROAS intent:

```sh
adrate gmvmax campaigns status --adv-id 70001 --campaign-id 80001 --set disable --auth-id 42 --idempotency-key gmv_80001_disable_001 --json
adrate gmvmax campaigns budget --adv-id 70001 --campaign-id 80001 --mode set --value 500 --auth-id 42 --idempotency-key gmv_80001_budget_500 --json
adrate gmvmax campaigns roas --adv-id 70001 --campaign-id 80001 --mode set --value 2.5 --auth-id 42 --idempotency-key gmv_80001_roas_25 --json
```

Status accepts only `enable` or `disable`. Budget and ROAS use `set`, `increase_amount`, `decrease_amount`, `increase_percent`, or `decrease_percent`; values must be positive and `decrease_percent` must be below 100. Budget accepts at most two decimal places and ROAS at most one decimal place.

All three writes are Command-backed. Preserve the original idempotency key and recover uncertain outcomes through `commands get`, `commands pending`, or the qualified `commands resume` path. Never retry the same intent with a fresh key. GMV Max Campaign deletion is not available through the CLI; do not approximate it with status, budget, ROAS, or Rule operations.

## Read and manage automation rules

Rules cover both Ads and GMV Max automation. All rule reads require an active subscription (including options queries).

Query available metrics, actions, and constraints for a given rule type and scope:

```sh
adrate rules options --rule-type ads --scope campaign --json
```

List rules with optional filters:

```sh
adrate rules list --rule-type ads --json
adrate rules list --keyword cpa --page 1 --page-size 50 --json
```

Read one rule with full pipeline, condition, and action detail:

```sh
adrate rules get --rule-id 42 --json
```

List execution records (at least one filter required):

```sh
adrate rules executions list --rule-id 42 --result success --json
adrate rules executions list --scope-id 80001 --from 2026-08-01 --to 2026-08-07 --json
```

Read one execution with condition evaluation detail (each metric's threshold, actual value, time window, and result):

```sh
adrate rules executions get --execution-id 1001 --json
```

Execution records include per-action status and value changes. The evaluation detail is self-contained: it includes the scope name and each metric's actual value, so no additional data-plane query is needed to explain "which object was hit and why".

Rule writes support Ads, GMV Max product promotion, and GMV Max live promotion. Promotion type `product` maps exactly to rule type `gmv_max_product`; promotion type `live` maps exactly to `gmv_max_live`. Use `rules options` as the source of truth before every create or update; never invent metrics, operators, actions, scopes, or limits from memory.

Before creating a GMV Max rule or changing its targets, run `gmvmax stores` and `gmvmax campaigns list`; use `gmvmax campaigns get` only when current Campaign details are needed. Then query `rules options` with the exact mapped rule type and intended scope. A GMV Max rule requires `authId`; every target uses `targetType: "campaign"` with `advId` and `shopId`. Include `campaignId` for a Campaign-bound target, or omit it for a full-store target. Do not send timezone in the effective window or targets: the server derives it from account data. GMV Max Rule budget action values accept at most two decimal places and ROAS action values at most one; values must be positive and percentage decreases must be below 100.

### Create, review, and enable

Follow this order for every new rule:

1. Discover the target and query its exact rule type and scope with `rules options`.
2. Create one rule. Creation always returns `enabled=false`.
3. Dry-run the disabled rule against one bound Campaign and show the Owner the returned targets, hits, and evaluation evidence.
4. Enable only after the Owner explicitly confirms the shown result.

```sh
adrate rules options --rule-type ads --scope campaign --json
adrate rules create --file rule.json --idempotency-key rule-create-0198f001 --json
adrate rules dryrun --rule-id 42 --adv-id 70001 --json
adrate rules enable --rule-id 42 --idempotency-key rule-enable-0198f002 --json
```

For a GMV Max rule, use the mapped type and pass all four dry-run fields:

```sh
adrate rules options --rule-type gmv_max_product --scope campaign --json
adrate rules dryrun --rule-id 43 --adv-id 70001 --shop-id shop-1 --campaign-id 80001 --json
```

A full-store rule target omits `campaignId`, but dry run always evaluates one Campaign and therefore requires both `--shop-id` and `--campaign-id`.

Dry run has no idempotency key because it does not mutate a rule. If it returns `notice: "busy"`, wait and retry later with bounded backoff; do not treat busy as a failed rule execution.

### Update or delete

Before updating, read the current rule, query `rules options` for its exact scope, and apply only the requested patch. Do not change its enabled state unless the Owner asked for that change. A disabled rule may be dry-run after the update; enabling it still requires explicit confirmation.

```sh
adrate rules get --rule-id 42 --json
adrate rules update --rule-id 42 --file patch.json --idempotency-key rule-update-0198f004 --json
adrate rules dryrun --rule-id 42 --adv-id 70001 --json
```

Delete a rule only after the Owner explicitly confirms deletion:

```sh
adrate rules delete --rule-id 42 --idempotency-key rule-delete-0198f005 --json
```

When the team is `frozen`, `rules disable` and `rules delete` remain available for risk reduction. `rules create`, `rules update`, and `rules enable` are unavailable.

Run `adrate schema <capabilityId> --json` to read each operation's own `available`, `unavailableReason`, and `idempotencyRequired` fields. `availabilityMode` summarizes availability only: `availabilityMode: "mixed"` means operations under that capability differ in availability, so read each operation's own fields. `availabilityMode: "uniform"` means they agree on availability — it does not mean they agree on `idempotencyRequired` or any other per-operation setting, which can still differ. Always take idempotency requirements from the operation you are about to call, never from the capability-level summary.

### Replay Rule write receipts safely

Rule writes use lightweight receipts, not the Command journal. Let the CLI generate an operation-prefixed key, or use the matching namespace: `rule-create-*`, `rule-update-*`, `rule-enable-*`, `rule-disable-*`, or `rule-delete-*`. Never reuse a key across operations or for changed input.

- On a confirmed non-retryable rejection that proves no mutation ran, correct each returned `validationErrors` item or resolve the stated business constraint, then retry with a new key.
- On a network failure, timeout, invalid response, or lost response, replay the exact same request with the original key. Do not change the body, target, or operation.
- `duplicate: true` means the server returned the original receipt; it does not mean a second mutation ran.

`commands get`, `commands pending`, and `commands resume` apply only to Command-backed Campaign Status, Budget, and ROAS writes. They cannot recover a Rule write. Never build a polling loop that scans Campaigns and issues bulk writes.

## Keep both conversion-rate definitions explicit

- `conversionRate` is the click-based conversion rate: conversion count divided by destination-page click count. TikTok has announced that this metric's definition will change, so preserve the API value and label it explicitly as click-based.
- `conversionRateV2` is the impression-based conversion rate: conversion count divided by total impressions. It is the recommended CVR to display.
- Never mix the two rates, use one to validate the other, or shorten both labels to the same generic "conversion rate".

## Preserve values and reporting limits

Display `spend`, currency amounts, and ratio fields as their original strings so precision is not lost. `null` means N/A, never zero. Do not add monetary values across different currencies. Reports are delayed, can receive attribution backfill, and can be truncated. Read `meta.pagination` and fetch only the pages the task needs; do not automatically download everything or simply average row-level ratios.

## Keep Campaign writes server-owned

Status accepts only `--set enable` or `--set disable`, corresponding to ENABLE/DISABLE intent. Budget and GMV Max ROAS accept `--mode` and `--value`; the server reads current state, locks the target, and applies the change. The CLI must not send `currentStatus`, `automationType`, `before`, or `after`; the server obtains fresh state and computes those fields. Do not attempt to reproduce the state machine locally.

## CLI exclusions

Do not use the CLI for standalone Campaign creation or Campaign deletion, batch operations, bid changes, independent Adgroup writes, independent Ad writes, Adgroup Copy, or Campaign Copy task cancellation. Use the documented `adrate rules` commands for supported Ads and GMV Max Rule creation, update, enable, disable, deletion, and dry run. GMV Max Campaign deletion remains unavailable even though confirmed Rule deletion is supported. Do not repurpose any supported Status, Budget, ROAS, Campaign Copy, or Rule command to approximate an excluded operation, and do not use undocumented endpoints.
