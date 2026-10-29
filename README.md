# hermes-data — GitHub-first durable state

This repository is the **primary, permanent home** of every durable artifact of
the Hermes instance it belongs to. The container filesystem is a rebuildable
cache; a fresh container restores itself from here.

- schema: `1` · tool `ghstore v1.0.0`
- generated: `2026-10-29T09:00:26.256939Z` · host `sandbox-b1e0eab0`
- files: `678` · bytes: `7046300`

## Layout

| path | contents |
| --- | --- |
| `state/` | durable Hermes state: config, memories, skills, plans, hooks, plugins, skins, cron jobs + scripts, workspace |
| `state/manifest.json` | per-file sha256 + size index; the integrity record |
| `tool/` | `ghstore.py` and bootstrap scripts — the restore path itself |

## Redacted before commit

`1` synced file(s) carried an inline credential
value, which was blanked before commit (an `api_key:` value becomes `''`); the
rest of each file is stored verbatim. Their paths and blanked-value counts are
listed in `state/manifest.json` under `redactions`, so a restore knows exactly
which credentials must be re-entered.

## Restore into a fresh container

```sh
export GITHUB_TOKEN=<token with access to this repo>
git clone https://github.com/amirmayeli1211/hermes-data.git /tmp/hermes-data
HERMES_HOME=/data/.hermes python3 /tmp/hermes-data/tool/ghstore.py pull --repo amirmayeli1211/hermes-data
```

## Never stored here

`.env`, `auth.json`, all `*.db` SQLite state (session transcripts, kanban,
cron executions), logs, caches, locks. A push that would leak a credential
aborts instead of committing.
