---
summary: Run Spendwatch's private dashboard in Docker using synthetic local data.
read_when:
  - Building or running the local Spendwatch dashboard container.
---

# Local Docker

```sh
docker compose -f compose.local.yml up --build -d --wait
```

Open http://localhost:28899. The image initializes a synthetic capacity report only when the persistent data volume is empty. Reports, capacity input, SQLite history, push state and VAPID keys live under `/data` in `spendwatch-local_data` and survive container replacement.

Host collectors remain outside this image. They should export sanitized reports and capacity data into the volume; agent transcripts, credentials and workstation homes are not mounted. The synthetic fixture has no push subscriptions, so it sends no notifications. Set a real VAPID subject and retain the private network boundary before deploying the server for real use.

Stop with `docker compose -f compose.local.yml down` while retaining the volume. Production is unchanged.
