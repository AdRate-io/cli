# @adrate/cli

English | [简体中文](./README.zh-CN.md)

The official thin client for the AdRate Public API. It supports Device Authorization, credential diagnostics, Ads and GMV Max Campaign reads and writes, Campaign Copy preview/submit/task queries, rule queries and single-rule writes, rule dry runs, explicit feedback submission, and two Agent Skills.

The CLI and the Agent Skills install in two steps:

```bash
npm install -g @adrate/cli
adrate skills install
```

## Command surface

```text
adrate auth login [--no-wait | --resume | --device] [--device-name <name>]
adrate auth status
adrate auth whoami
adrate auth logout
adrate capabilities
adrate schema <capabilityId>
adrate ads advertisers
adrate ads campaigns list --adv-id <id>
adrate ads campaigns get --adv-id <id> --campaign-id <id>
adrate ads campaigns status --adv-id <id> --campaign-id <id> --set enable|disable
adrate ads campaigns budget --adv-id <id> --campaign-id <id> --mode <mode> --value <value>
adrate ads report campaigns --adv-id <id> --start-date <date> --end-date <date>
adrate ads copy submit --file <copy.json>
adrate ads copy preview --file <copy.json>
adrate ads copy tasks [--status <status>] [--page <n>] [--page-size <1..100>]
adrate ads copy tasks get --task-id <id>
adrate gmvmax stores --adv-id <id>
adrate gmvmax campaigns list --adv-id <id> --store-id <id> --promotion-type product|live
adrate gmvmax campaigns get --adv-id <id> --campaign-id <id> --store-id <id>
adrate gmvmax campaigns status --adv-id <id> --campaign-id <id> --set enable|disable --auth-id <id>
adrate gmvmax campaigns budget --adv-id <id> --campaign-id <id> --mode <mode> --value <value> --auth-id <id>
adrate gmvmax campaigns roas --adv-id <id> --campaign-id <id> --mode <mode> --value <value> --auth-id <id>
adrate rules options --rule-type <type> --scope <scope>
adrate rules list [--rule-type <type>] [--keyword <text>]
adrate rules get --rule-id <id>
adrate rules create (--file <rule.json> | --stdin)
adrate rules update --rule-id <id> --file <patch.json>
adrate rules enable --rule-id <id>
adrate rules disable --rule-id <id>
adrate rules delete --rule-id <id>
adrate rules dryrun --rule-id <id> --adv-id <id> [--shop-id <id>] [--campaign-id <id>]
adrate rules executions list (--rule-id <id> | --scope-id <id>)
adrate rules executions get --execution-id <id>
adrate commands get (--command-id <uuid> | --idempotency-key <key>)
adrate commands pending
adrate commands resume --idempotency-key <key>
adrate feedback --category blocked|bug|suggestion|other (--message <text> | --message-stdin)
adrate skills list
adrate skills read <name> [path]
```

Production is the default issuer. `--test` selects the test environment only when no credential exists locally and a new Device Flow is being created. The CLI does not support arbitrary base URLs, disabling TLS, team switching, or multiple profiles.

`auth login --device` targets device-code machine consumers: once the code is issued, it prints one top-level JSON line to stdout containing `verificationUriComplete`, `verificationUri`, `userCode`, and `expiresIn`, then keeps polling until authorization or expiry. It is mutually exclusive with `--no-wait` and `--resume`. Combined with `--json`, stdout carries exactly two JSON lines: the device-code fields first, the final envelope second.

Device Authorization requests exactly the following 16 capabilities. The order is itself part of the local state contract:

```text
identity.read
connections.read
ads.campaign.read
ads.report.read
ads.copy.read
ads.copy.write
ads.campaign.status.write
ads.campaign.budget.write
feedback.write
rules.read
rules.write
rules.dryrun
gmvmax.read
gmvmax.campaign.status.write
gmvmax.campaign.budget.write
gmvmax.campaign.roas.write
```

`/public/v1/me` is the server endpoint that activates a new Session. Both `auth status` and `auth whoami` call it whenever a Token exists locally.

## Authentication and local state

Device Token responses are recovered as minimal transient state; no Token copy or local delivery ledger is kept. Before a credential is committed, the CLI verifies the generation and flow identity captured when login started, so a stale login result can never overwrite or delete a credential written later. When it cannot safely confirm that a Token was committed, the CLI clears same-generation transient state and requires a fresh login; unactivated Sessions expire on the server.

`auth logout` clears a still-matching local credential only when the server returns an exact revoked success body, or one of the exact business codes `INVALID_CREDENTIAL`, `CREDENTIAL_EXPIRED`, or `USER_DISABLED`. Transport failures, HTTP 401/403, `OWNER_REQUIRED`, unknown business codes, and any other indeterminate result keep the credential, report unknown, and exit 5; you can retry or confirm in the browser. If the TokenIndex exists but the secret is confirmed missing, an explicit logout clears only the local remnant, still reports the remote state as unknown, and exits 5.

The CLI prefers the operating system Keychain through the exactly pinned optional dependency `@github/keytar@7.10.6`. When a new login cannot use the Keychain, the CLI warns explicitly and falls back to a permission-checked file; a credential already pinned to the Keychain by the local index is never silently downgraded. State directories and files continue to enforce permissions, symlink rejection, path containment, atomic replacement, and Windows ACL checks.

## Write command recovery

Command-style Campaign writes persist a minimal pending record holding credentialId, issuer, idempotencyKey, capability, target resource, the original intent/payload, and timestamps. When an unresolved operation already exists for the same resource, a new key does not overwrite it; on transport failure or insufficient evidence the pending record is kept and the CLI exits 5.

`commands resume` first queries by the original idempotency key, and only resends with the original key and original payload when the server returns an exact 404 and the pending record is still within the recovery window. The CLI reports success only when the credential, key, capability, target resource, commandId, and positive terminal-state evidence all match; every other result keeps the recovery entry rather than treating unknown as success.

## Explicit feedback

`adrate feedback` sends a single 15-second JSON POST, and only when a user or Agent invokes it explicitly. Before submitting, remove Tokens, Authorization/Cookie values, passwords, device codes, TikTok access tokens, personal information, full ad payloads, environment variables, logs, and stack traces; server-side known-pattern scrubbing is a backstop and does not prove the body is safe. The CLI attaches only its own version, platform architecture, and Node version — never hostname, cwd, paths, command history, or environment variables. Prefer `--message-stdin` for free text; `--message` suits only short text already confirmed non-sensitive, because it can persist in shell history or process argv. Never concatenate the body into a shell command string. The CLI does not auto-report, retry in the background, or write a pending ledger. When a receipt cannot be confirmed, the failure output prints that invocation's idempotency key; retry is bounded and must reuse the same category, the same message, and that same key.

## Rule writes and dry runs

`rules create` reads JSON from either `--file` or `--stdin`; `rules update` accepts only `--file`. The CLI validates only that the input is valid JSON with a top-level object — rule structure and field constraints are the server's to define. `enable`, `disable`, and `delete` send a POST with no body at all, not `{}`.

Each of the five rule write commands sends at most one 15-second request, writes no pending Command ledger, and never retries automatically. Without an explicit `--idempotency-key`, the CLI generates an operation-scoped key: `rule-create-*`, `rule-update-*`, `rule-enable-*`, `rule-disable-*`, or `rule-delete-*`. On a network failure, timeout, or unconfirmable receipt, replay using the original key printed in the error and byte-identical input; for a business error the server explicitly rejected, correct the input first and then use a new key.

`rules dryrun` is a standalone 60-second JSON POST with no idempotency key that evaluates a rule without executing actions. GMV Max rules pass target context through `--shop-id` and `--campaign-id`, which must be supplied together. Human output prints one line per target; `--json` preserves the full server envelope. If an older Session lacks the required scope, the CLI asks you to reauthorize via `auth logout`, `auth login`, and `auth whoami` — it never migrates a Session automatically.

## Campaign Copy

`ads copy submit` and `ads copy preview` accept only `--file`. The CLI confirms only that the file is a valid JSON plain object; object fields, structure, and defaults are entirely the server's, and no DTO is duplicated locally. Each command sends one 45-second POST, never retries automatically, and accepts neither `--stdin` nor `--wait`.

A submit exit code of 0 means the copy task was accepted, not that copying finished. On a network failure, timeout, or unconfirmable receipt evidence the CLI exits 5: replay only with the original idempotency key from the error and a byte-identical JSON body, never a new key. For validation or quota problems the server explicitly rejected, fix them first, then submit the corrected body under a new key. Submit writes no Command pending ledger.

Preview carries no idempotency key and uses no receipt, Command, or local pending record; on a network failure, timeout, or invalid response it exits 4 and may be retried after bounded backoff. `ads copy tasks` reads a single page and `ads copy tasks get` reads a single task; neither paginates nor polls automatically. Poll with get until `completed`, `failed`, or `partial`; `partial` is terminal and requires inspecting per-item results.

## Agent Skills

The two Skills are fixed as `adrate-shared` and `adrate-ads`. `skills-content` holds the full text; `skills` holds the install shell, manifest, and OpenAI configuration.

`adrate skills install` copies only allowlisted files from the current npm package into `~/.agents/skills/`, without network access or git. Before writing, it validates the Skill name, the frontmatter/manifest/openai schema, in-package digests, UTF-8, size, safe relative paths, and regular-file boundaries; writes use a temporary directory and atomic replacement. An older CLI never silently overwrites an installed Skill of a higher version.

`skills list` and `skills read` require no authentication and make no network requests. At startup the CLI may surface missing or outdated installs through `_notice.skills`; setting `ADRATE_NO_SKILLS_NOTIFIER=1` disables that local check without affecting business exit codes.

## Windows boundaries

Windows state directories use a protected DACL and reject reparse points. The ACL helper runs only a fixed PowerShell program, and neither path nor PID input reaches argv. Token fallback read/write/remove are fail-closed by design.

## Scope boundaries

The CLI package provides the generic device-code machine output of `auth login --device` and local authentication state management. Third-party platform Plugin manifests, Connectors, and Skill packages are not part of the npm package.

## Distribution surface

The package exposes only the `adrate` binary. `exports` is empty, and importing the package root or maintenance scripts as a library is unsupported. The published package keeps source maps without `sourcesContent` for stack resolution, and ships no TypeScript sources, tests, lockfile, release material, or private modules from the main application.

The release flow first completes tests, build, a single pack, content and secret scanning, and a packed smoke test; it then verifies the identity and SHA-256 of that same artifact, and finally publishes that tarball through npm Trusted Publishing.
