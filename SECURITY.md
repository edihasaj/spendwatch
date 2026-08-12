# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Please do not
open a public issue for a suspected vulnerability and do not include live API
keys, authentication files, raw agent transcripts, or generated dashboards in a
report.

Include the affected version or commit, reproducible steps, impact, and any
suggested mitigation. You should receive an acknowledgment within three
business days and a status update within seven business days.

## Supported versions

Security fixes target the current `master` branch and the latest published
release. Older versions may require upgrading before a fix can be applied.

## Deployment boundary

Spendwatch source is public. Generated reports, quota snapshots, databases,
provider credentials, Web Push keys, telemetry DSNs, dashboard hostnames, and
private deployment configuration must remain outside this repository.
