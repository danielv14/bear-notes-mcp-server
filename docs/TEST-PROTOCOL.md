# End-to-end test protocol

**This file is instructions for a Claude Code session, not a script.** Working
through it means creating one real note in the user's real Bear library, reading
it, modifying it, tagging and untagging it, archiving it and finally trashing
it, and confirming after every write that Bear actually did the thing.

Run it before merging any change that touches the read queries, the write path,
the tool surface, or the note/URL rendering. Also worth running after a Bear or
macOS update, since the parts most likely to break are the parts this repo does
not control.

The quickest way to run it is `/bear-protocol`, the repo-local skill in
`.claude/skills/bear-protocol/`. It is a thin layer over this file, which stays
the source of truth.

## Why this exists alongside `bun test`

| Pass | What it drives | What it proves |
|---|---|---|
| `bun test` | in-memory SQLite fixture, stubbed URL runner | the code agrees with the fixture |
| this protocol | the `bear` MCP server Claude Code has **connected**, real Bear | the thing the user actually uses works, and writes are confirmed outside this repo's own read code |

The second row is the point. Nothing else here talks to Bear, and a check that
verifies a write by reading the note back through `bear_get_note` makes the read
path the witness for the write path: one shared bug can make both agree and both
be wrong. Here you verify with a raw `sqlite3` query that does not go through
this repo at all, and you have a human who can look at Bear's window.

This file used to describe a script, `scripts/e2e-bear.ts`, that drove
`src/server.ts` as a subprocess. It was removed once this protocol existed: it
was a second, weaker copy of the same run, and its checks live here now. Anything
worth asserting about Bear goes in the phases below.

## Ground rules

1. **One run, one stamp.** Everything you create carries the same run-unique
   stamp and marker. Never match on a title fragment that could belong to a real
   note.
2. **Touch nothing you did not create.** No reading, editing, trashing or
   archiving of the user's notes. `bear_rename_tag` and `bear_delete_tag` act
   library-wide: call them only with this run's tag names, and re-read the name
   you are about to pass before you pass it.
3. **A write tool answering `Sent to Bear:` is not evidence.** Writes are
   fire-and-forget. Record a pass only after the verification query shows the
   expected state.
4. **Report honestly.** A step you skipped is skipped, not passed. Quote the
   actual tool response and query output for anything that fails.
5. **Always run the cleanup phase**, even if earlier phases failed. If cleanup
   cannot finish, tell the user exactly what is left in their library and how to
   remove it.
6. **Do the `EYES` checkpoints.** They are the questions SQLite cannot answer.
   Ask the user, wait for the answer, and record what they said. If the user
   wants to skip them, note them as unverified rather than passed.

## Step 0: confirm what you are about to test

Do not skip this. A stale MCP connection makes the whole run meaningless.

1. **Record the code under test.** Branch, short SHA, and whether the working
   tree is dirty (`git status --short`). Name any uncommitted file, since it is
   part of what you are testing.
2. **Confirm the connected server is that code.** The user's config runs
   `bun run <repo>/src/server.ts` from source, so the connection reflects the
   working tree *at the moment the connection was made*. If you edited `src/`
   during this session, or the session started before the change landed, the
   connected server is stale.
   - Compare your `mcp__bear__*` tool list against the tool table in
     `src/server.ts`: same names, same count. That is also the tool-surface
     check, so record it as S1: 13 tools registered, matching the table.
   - S2: `bear_unarchive_note` must not be there. It was removed, and Bear's URL
     scheme has no `unarchive` action. If it is still in your tool list, the
     connection is stale. Reconnect the `bear` server (`/mcp`) or start a fresh
     session, then start this protocol over.
   - S3: `bear_search` advertises exactly `term`, `tag`, `limit` and `offset`.
3. **Bear must be running.** `pgrep -x Bear`. Ask the user to open it if not; a
   cold launch triggered by the first `bear://` URL adds a lot of delay and
   makes the first poll look like a failed write.
4. **Record the environment**, because a result is only true for one of these:
   ```bash
   defaults read /Applications/Bear.app/Contents/Info.plist CFBundleShortVersionString
   sw_vers -productVersion
   ```
5. **Run the cheap passes first** and report their result:
   `bun run typecheck && bun test`. If those fail, stop and fix. There is no
   point spending the user's attention, or writing to their library, while the
   fixture suite is red.

## Setup: the run stamp and the verification query

Pick the stamp once and reuse it for the whole run:

```bash
RUN=$(date +%Y%m%d-%H%M%S)          # e.g. 20260727-143512
MARKER="zqx${RUN//-/}"              # a token that cannot collide with a real note
```

Names to use, all derived from the stamp:

| Purpose | Name |
|---|---|
| Note title | `MCP protocol <RUN>` |
| Plain tag | `mcp-protocol-<RUN>` |
| Nested tag | `mcp-protocol-<RUN>/nested` |
| Multiword tag | `mcp-protocol-<RUN> med mellanslag` |
| Renamed tag | `mcp-protocol-<RUN>-renamed` |

The verification query. Note that the join table and its columns are named after
Core Data's generated entity ids, so derive them instead of hardcoding `Z_5TAGS`
and `Z_13TAGS`:

```bash
DB="$HOME/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite"
# Fall back to this path if the first does not exist (Bear without iCloud):
# DB="$HOME/Library/Containers/net.shinyfrog.bear/Data/Documents/Application Data/database.sqlite"
NOTE_ENT=$(sqlite3 -readonly "$DB" "SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME='SFNote';")
TAG_ENT=$(sqlite3 -readonly "$DB" "SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME='SFNoteTag';")

sqlite3 -readonly -line "$DB" "
SELECT n.ZUNIQUEIDENTIFIER AS id, n.ZTITLE AS title,
       n.ZTRASHED AS trashed, n.ZARCHIVED AS archived,
       (SELECT group_concat(t.ZTITLE, ' | ') FROM Z_${NOTE_ENT}TAGS j
          JOIN ZSFNOTETAG t ON t.Z_PK = j.Z_${TAG_ENT}TAGS
         WHERE j.Z_${NOTE_ENT}NOTES = n.Z_PK) AS tags,
       n.ZTEXT AS body
FROM ZSFNOTE n WHERE n.ZTEXT LIKE '%${MARKER}%';"
```

Always open the database `-readonly`. Never write to it, and never work around a
missing tool by writing SQL: the write path under test is the URL scheme.

**Polling.** Bear applies a write asynchronously, so a change is not in SQLite
the instant the tool returns. Poll rather than sleeping blind, and treat a
timeout as a failed write with the caveat noted in the report:

```bash
for i in $(seq 1 30); do
  hit=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM ZSFNOTE WHERE ZTEXT LIKE '%${MARKER}%';")
  [ "$hit" -gt 0 ] && { echo "visible after ${i}s"; break; }
  sleep 1
done
```

Adapt the inner `SELECT` per phase. If something never appears, say how long you
waited: `open` exits as soon as macOS finds a handler, so a write Bear ignored
and a write Bear has not flushed look identical from here, and the wait is the
only thing that separates them.

## Phase 1: create

Call `bear_create_note` with the title, a body containing the marker and a few
deliberately awkward tokens, and all three tags in three different notations:

```
title: MCP protocol <RUN>
text:  Nästa möte om <MARKER>. Rabatt 50% och file_name här.
tags:  ["mcp-protocol-<RUN>", "#mcp-protocol-<RUN>/nested", "#mcp-protocol-<RUN> med mellanslag#"]
```

| Check | Expected |
|---|---|
| C1 | The response starts with `Sent to Bear:` and does not claim the note was created |
| C2 | The verification query returns exactly one row, and you record its `id` |
| C3 | `title` is byte-identical to what you sent, `å ä ö` intact |
| C4 | `trashed` and `archived` are `0` or empty, not `1` |
| C5 | `tags` lists all three, stored without `#`, the nested one keeping its `/`, the multiword one as a single tag rather than split in two |
| C6 | `body` contains the marker, `50%` and `file_name` unchanged |

**EYES 1.** Ask the user to look at the note in Bear and answer: is the title
rendered as a heading rather than literal `# `? Does the tag bar show three
tags, with the multiword one as one tag? Does the body read as intended text
rather than escaped junk?

## Phase 2: read it back through the server

Same note, now through the tools. Any field where the server disagrees with the
verification query from Phase 1 is a bug in this repo's read path, which is the
whole reason the raw query exists.

| Check | Call | Expected |
|---|---|---|
| R1 | `bear_get_note(id)` | `id`, `title`, `content`, `tags` match the raw row |
| R2 | same | `isTrashed` and `isArchived` are both `false` (present, not missing) |
| R3 | same | `createdAt` / `modifiedAt` look like `2026-07-27T06:09:00Z`, with the `Z` |
| R4 | `bear_search(term: MARKER)` | the note is found |
| R5 | `bear_search(term: "MÖTE OM <MARKER uppercased>")` | still found, so non-ASCII folding works in both directions |
| R6 | `bear_search(term: "50%")` and `bear_search(term: "file_name")` | found, so `%` and `_` are literal and not SQL wildcards |
| R7 | any search | the response is `{ notes, count, limit, offset, hasMore }`, and `count` is the size of that page |
| R8 | `bear_list_by_tag(tag: "#MCP-PROTOCOL-<RUN>")` | the note is found, so a leading `#` and the wrong case both resolve |
| R9 | `bear_search(tag: "mcp-protocol-<RUN>")` | the same notes as R8, in the same order |
| R10 | `bear_list_tags()` | contains the plain, the nested and the multiword tag, each once |
| R11 | `bear_search(term: MARKER)` | the note in the page carries neither `isTrashed` nor `isArchived`: live results are known-live, and the flags belong to `bear_get_note` and `bear_list_archived` |
| R12 | `bear_search(limit: 2)` | exactly 2 notes, and `hasMore` is `true` |
| R13 | `bear_search(limit: 2, offset: 2)` | 2 notes, none of them the notes from R12 |

R12 and R13 read across the user's whole library rather than this run's note.
They are read-only, so that is fine, but do not report anything about the notes
they return beyond the ids you needed to compare.

## Phase 3: modify

One write at a time, verified against the raw query before the next.

| Check | Call | Expected |
|---|---|---|
| M1 | `bear_append(id, "\n\nAPPENDED-<MARKER>")` | the raw `body` ends with the appended text, and the original body is still there |
| M2 | `bear_prepend(id, "PREPENDED-<MARKER>\n\n")` | the raw `body` starts with the prepended text |
| M3 | `bear_replace_content(id, title: "MCP protocol <RUN> REPLACED", text: "Replaced body <MARKER>", tags: [plain tag])` | the raw `title` is the new title, the raw `body` is the new body, and neither the appended nor the prepended text survives |
| M4 | same row | the body does not begin with a bare `# ` heading with nothing after it |
| M5 | `bear_get_note(id)` | reports the same title and body as the raw row |

**EYES 2.** Ask the user: after the replace, does the note in Bear look like a
normal note, with one title heading and the tag still attached, rather than
a duplicated heading or a note that lost its tags?

## Phase 4: tag operations

These must run **while the note is still live**. Once the note is trashed its
tags drop out of `bear_list_tags` anyway, and a tag check run afterwards passes
whether or not the tool did anything.

| Check | Call | Expected |
|---|---|---|
| T1 | `bear_rename_tag(name: plain tag, newName: renamed tag)` | the raw `tags` column carries the new name |
| T2 | same | the old name is gone from the raw row |
| T3 | `bear_list_tags()` | shows the new name, not the old one |
| T4 | `bear_list_by_tag(renamed tag)` | finds the note under its new name |
| T5 | `bear_delete_tag(name: "#mcp-protocol-<RUN> med mellanslag#")` | the multiword tag disappears from the raw `tags` column, so Bear's own `#multiword#` notation is accepted on the way in |
| T6 | `bear_list_tags()` | no longer lists the multiword tag |

## Phase 5: bad input is refused, and refusing leaves no trace

Each of these must come back as an error result, and must not create anything.
After the phase, re-run the verification query and confirm the note count for
the marker is still exactly one.

| Check | Call | Expected |
|---|---|---|
| V1 | `bear_create_note(title: "   ", text: "x")` | error, no note created |
| V2 | `bear_list_by_tag(tag: "  ")` | error |
| V3 | `bear_search(tag: "#")` | not an error: a `#`-only tag means no tag filter |
| V4 | `bear_get_note(noteId: "NO-SUCH-NOTE")` | error naming the unknown id |
| V5 | `bear_create_note(title: "oversized-<RUN>", text: <120000 "ä">)` | error mentioning the character limit, and no note titled `oversized-<RUN>` exists in the raw table |

V5 matters more than it looks: the point is that an oversized payload is refused
rather than truncated, because a truncated `bear_replace_content` would overwrite
a real note with a partial copy.

## Phase 6: archive

| Check | Call | Expected |
|---|---|---|
| A1 | `bear_archive_note(id)` | the raw row shows `archived = 1` |
| A2 | `bear_get_note(id)` | `isArchived` is `true` |
| A3 | `bear_list_archived()` | the note is in the page, carrying `isArchived: true` |
| A4 | `bear_search(term: MARKER)` | the note is gone from live results |

There is no un-archive: Bear's URL scheme has no such action, so the note stays
archived until Phase 7 trashes it. Do not ask the user to un-archive it by hand.

## Phase 7: trash it and clean up

Bear's API has no permanent delete, so "delete" means trash.

| Check | Call | Expected |
|---|---|---|
| D1 | `bear_trash_note(id)` | the raw row shows `trashed = 1` |
| D2 | `bear_get_note(id)` | `isTrashed` is `true`, and the note is still readable |
| D3 | `bear_search(term: MARKER)` | no live hit |

Then remove the run's tags, whichever survive:
`bear_delete_tag` for the renamed tag, the nested tag, the multiword tag and the
plain tag.

| Check | Expected |
|---|---|
| D4 | `bear_list_tags()` contains no tag starting with `mcp-protocol-<RUN>` |
| D5 | The verification query returns the note as trashed and nothing else from this run remains live |

A `ZSFNOTETAG` row can survive in the raw table after the last note using it is
gone. That is Bear's behaviour, not a leak: a tag with no live notes is
invisible to `bear_list_tags`. Note it, do not chase it.

Finally, tell the user in plain words: the note is in Bear's trash under the
title `MCP protocol <RUN> REPLACED`, and they can empty the trash themselves if
they want it gone for good.

## Reporting

Report to the user, in this order:

1. **Environment.** Branch, short SHA, dirty files, Bear version, macOS version,
   and confirmation that the connected server matched the code.
2. **Cheap passes.** Result of `bun run typecheck` and `bun test`.
3. **Result table.** One line per check id, `pass` / `fail` / `skipped`, with the
   observed value for anything that is not a plain pass.
4. **Failures in full.** The exact tool response and the exact query output. No
   paraphrasing.
5. **What you could not verify**, including any `EYES` checkpoint the user did
   not answer, and any poll that timed out rather than confirming.
6. **Leftovers.** What is still in the library, if anything.

Then, in the PR description, say the protocol ran, on which Bear version, and
name the phases that were skipped. Do not imply the run proved more than it did.

## What this protocol cannot prove

- **That Bear accepted a write it chose to ignore.** `open -g` exits as soon as
  macOS finds a handler and Bear answers nothing, so every write here is judged
  by reading state back afterwards. That catches a write that did nothing, but
  cannot separate "Bear rejected it" from "Bear has not flushed yet". The poll
  timeout is the only signal you have.
- **Un-archiving.** No such action in Bear's API.
- **A Bear schema renumbering.** Entity-id discovery is exercised against
  fixtures in `src/bear-schema.test.ts`. A real renumbering can only be observed
  when Bear ships one, and the derived ids in the verification query above are
  the closest this protocol gets.
- **Sync.** Nothing here waits for iCloud, or checks another device.
- **Concurrency.** One run, one note, no competing writer. Bear holding the
  database open while the user edits is not simulated.
- **Other Bear versions, other macOS versions, other libraries.** A pass is a
  pass for the environment recorded in step 0 and nothing else.

## Extending it

Add a check whenever a change introduces behaviour the fixture cannot model:
anything about how Bear parses, stores, or silently ignores what we send. Put it
in the phase it belongs to, give it an id, verify it with the raw query rather
than only through the tools, and make sure whatever it creates is cleaned up in
Phase 7. If a check needs the note live, it goes before Phase 6.

Resist turning a check back into a script. A check that a script can make is a
check whose witness is our own code, which is what the fixture suite already
does. What belongs here is anything where Bear, or the user, is the witness.
