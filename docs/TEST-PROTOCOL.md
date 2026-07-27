# End-to-end test protocol

The unit suite runs against an in-memory SQLite fixture and a stubbed URL
runner. Neither touches Bear. That is deliberate - it keeps `bun test` fast and
runnable anywhere - but it means a green suite proves the code agrees with the
fixture, not that it agrees with Bear.

Several classes of defect only show up against the real thing:

- a `bear://` action name or parameter that Bear silently ignores, since `open`
  exits 0 either way and Bear reports nothing back
- Core Data schema assumptions (entity ids, nullable columns, join tables)
- how Bear actually parses a rendered tag, a multiword tag, or an H1 title
- Unicode: what Bear stores for `å/ä/ö` and whether matching finds it
- the flush delay between a write landing in Bear and appearing in SQLite

So: **after any change to the read queries, the write path, the tool surface,
or the note/URL rendering, run the end-to-end check before merging.**

## Running it

Requires macOS with Bear installed and opened at least once.

```bash
bun run typecheck
bun test
bun run e2e
```

`bun run e2e` spawns `src/server.ts` as a subprocess and drives it over stdio
JSON-RPC, exactly the way Claude Code does. It exercises the tool table, the
Zod schemas, the `bear://` URL scheme and the SQLite reads together, with
nothing mocked. It exits non-zero if any check fails.

**It writes to your real Bear library.** Everything it creates is named with a
run-unique timestamp, and it trashes the note and deletes its tags before
exiting. The trashed note stays in Bear's trash - empty it yourself if you
care. Expect the run to take a minute or so: it polls for each write to reach
SQLite rather than sleeping a fixed amount.

## What it covers

| # | Area | What is asserted |
|---|---|---|
| 1 | Tool surface | 13 tools registered, no `bear_unarchive_note`, `bear_search` advertises `term`/`tag`/`limit`/`offset` |
| 2 | Create | Plain, nested (`a/b`) and multiword (`#my tag#`) tags; the response says what was *sent*, not that it was applied |
| 3 | Read back | Title round-trips, `isTrashed`/`isArchived` present and false, timestamps are ISO-8601 UTC, all three tags stored the way Bear expects |
| 4 | Search | Non-ASCII case folding (`MÖTE` finds `möte`), `50%` and `file_name` match literally, the response is a page, live results carry no status flags |
| 5 | Tag lookup | A leading `#` and the wrong case both resolve; `bear_search(tag)` and `bear_list_by_tag` return identical notes |
| 6 | Append / prepend | Text actually lands in the note |
| 7 | Replace | `mode=replace_all` replaces the title too; no bare `"# "` heading |
| 8 | Rename tag | The note carries the new name, the old name is gone from both the note and `bear_list_tags`, lookup works under the new name |
| 9 | Delete tag | A tag given in Bear's `#multiword#` form is deleted, and comes off the note |
| 10 | Validation | Blank title rejected, blank tag rejected by `bear_list_by_tag`, `"#"`-only tag means no filter in `bear_search`, unknown note id errors, oversized payload refused rather than truncated |
| 11 | Paging | The first page is capped and reports `hasMore`; an offset returns different notes |
| 12 | Archive and trash | `bear_get_note` reports archived, the note appears in `bear_list_archived` and leaves live search, an archived note can still be trashed |

Steps 8 and 9 run **before** the note is trashed on purpose. Once the note
leaves the live set the tag drops out of `bear_list_tags` regardless, so a
tag-deletion check run afterwards passes whether or not `delete-tag` did
anything.

## What it cannot cover

Say so in the PR rather than implying the run proved more than it did.

- **Whether Bear accepted a write it chose to ignore.** `open -g` exits as soon
  as macOS finds a handler for `bear://`; Bear never answers. Every write check
  here works by reading the note back out of SQLite afterwards, which catches a
  write that did nothing but cannot distinguish "Bear rejected it" from "Bear
  has not flushed yet" - hence the polling with a timeout.
- **Un-archiving.** Bear's API has no `unarchive` action, so a note archived by
  the run can only be restored in Bear's UI. The run trashes it instead.
- **A Bear schema change.** Entity-id discovery is exercised against fixtures
  in `src/bear-schema.test.ts`; a real renumbering can only be observed when
  Bear ships one.
- **Other platforms or Bear versions.** Record which macOS and Bear version the
  run was done on when it matters.
- **Sync.** Nothing here waits for iCloud.

## Adding to it

Add a check whenever a change introduces behaviour that the fixture cannot
model - anything about how Bear parses, stores, or ignores what we send it. Put
it in the section it belongs to, keep it independent of the library's existing
contents (match on the run's `MARKER`, never on a real note), and make sure
anything it creates is cleaned up at the end of the run.

If a check needs the note to still be live, put it before step 12.
