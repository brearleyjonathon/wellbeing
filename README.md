# Wellbeing

A sidebar panel for the `mood`, `energy` and `focus` scores that live in your
daily notes' frontmatter. Log the day by clicking a number; read the trailing
month as a heatmap without opening anything.

![sidebar](#)

## Why it exists

These scores were previously rendered by `daily_note.py`, which appended an
inline-HTML heatmap to the bottom of each morning's note. That worked, but it
meant every note carried a copy of the same thirty-day picture, the picture was
already stale by the time you read it, and logging a score still meant scrolling
up and editing YAML by hand.

A sidebar is the right shape for this: one panel, always current, and the scale
buttons write the frontmatter for you.

## The data

The notes are the only store. Nothing is kept in plugin settings and nothing is
duplicated:

```yaml
---
date: "2026-09-22"
mood: 7
energy: 6
focus: 8
---
```

`0` or a missing key means "not logged", which is what the Daily template seeds
each new note with. Clicking a score that is already set writes `0` again, so
clearing a mistake is the same gesture as making it.

Notes are looked up at `01_Daily Notes/YYYY/MM-Month/DD-Weekday.md` — one direct
path per day rather than a vault scan, so the panel stays instant on a large
vault and a folder stuck syncing can't stall it.

## Using it

- **Ribbon icon** (the pulse) or the **Open wellbeing sidebar** command opens the
  panel in the right leaf.
- The **top block** logs the selected day. It starts on today.
- The **history** lists the trailing window, newest first, three columns across.
  Clicking any row moves the logger to that day, which is how you fill in one you
  missed. A greyed date means there is no note for that day at all, so there is
  nowhere to write a score — that resolves itself when the 6am job creates it.
- The **footer** averages each metric over the window, counting only logged days.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Daily notes folder | `01_Daily Notes` | Vault-relative. Notes are expected at `YYYY/MM-Month/DD-Weekday.md` beneath it. |
| Days shown | `30` | 7–90. |

## Developing

There is no build step — `main.js` is the source, plain CommonJS against the
Obsidian API. Deploy by copying the three files Obsidian reads:

```bash
./deploy.sh                      # into C:/Users/brear/Documents/Quartz
./deploy.sh /path/to/other/vault # somewhere else
```

`data.json` on the far side is the vault's own settings and is never touched.

The month and weekday names in the note path are hard-coded English rather than
taken from the runtime locale, because `daily_note.py` writes them with
`strftime` under the C locale. If the path format changes in either place, it has
to change in both.
