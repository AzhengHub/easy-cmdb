# Security Policy

## Supported versions

LinkCMDB is pre-1.0. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Email **security@linkcmdb.com** with:

- the affected version or commit,
- a description of the issue and its impact,
- steps to reproduce, ideally against a throwaway SQLite database,
- any suggested fix.

You will receive an acknowledgement within 7 days. Once a fix is ready, the report and the fix are published together, and the reporter is credited unless they prefer otherwise.

## Scope

In scope: authentication and session handling, captcha issuance, CSV import, SQLite access, the installer and systemd unit, and anything that could expose asset data.

Out of scope: issues that require an already-compromised host, and reports about demo data sets.

## Disclosure policy

Please allow a reasonable window to ship a fix before publishing details. There is no bug bounty.
