# Forge · Design Book

A local-first creative workbench for developing a game's design. The director owns the decisions; AI is a conversational partner. This foundation includes project management, a rich-text Design Book, and a contextual AI Workshop with explicit proposal review.

## Run locally

Requires **Node.js 24+** and npm. SQLite uses Node's built-in driver; no separate database service or native module installation is needed.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs at `127.0.0.1:4310`. Both bind to loopback. Keep the terminal running while using Forge.

For a single-server production build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4310**. A production build is served by the local backend. There is no hosted account or cloud database.

## Your first project

Create a game project with an optional title and optional idea. Forge opens its Design Book with one **Game Vision** chapter; your idea becomes the initial chapter text. Blank projects are supported. Add other chapters when you need them. Chapters can have separately editable sub-chapters: choose a parent in **Place under** when adding or editing a chapter. The workspace sidebar shows each project with its **Design Book** feature beneath it and chapters inside the book. Expand or collapse a project, its Design Book, or any chapter with sub-chapters using its chevron. Collapse choices are remembered on this browser; collapsing a branch keeps its chapter open in the editor. The sidebar shows nested numbering such as 02.01. Moving a chapter keeps its content, maturity, and Workshop conversation.

Archiving a chapter removes it from the current book while preserving its saved versions, approvals, and Workshop evidence. Archiving a parent moves its sub-chapters up one level. Open **Archived chapters** to inspect history or return a chapter to the book. The reorder arrows move a chapter among its siblings.

Use the document toolbar for headings, emphasis, lists, quotes, and links. Edits autosave after a short pause. Click the save indicator or press Ctrl/Cmd+S to save immediately. Navigation waits for pending saves; failed saves keep your edits in the editor and offer retry or explicit reload. Reorder chapters using the arrows beside a sidebar chapter. Rename chapters by editing their title; rename the project through Project details.

Maturity can be Exploring, Proposed, Approved, or Needs Revision. Use **Approve current version** to approve the exact saved chapter version. Editing its title, content, or formatting marks the newer content unreviewed and preserves the previous approval. Moving a chapter does not invalidate content approval. These are design decisions and do not imply Unity implementation. Ctrl/Cmd+K searches projects and the active project's chapter titles. The Workshop can be hidden; small screens stack it below the document.

Open **History** beside a chapter's title to inspect saved versions with their original formatting, compare against the last approved version, or restore earlier title/content into a new unreviewed version. Restoration preserves the chapter's current location and all earlier versions. Existing projects receive a baseline snapshot at their current revision during migration; earlier versions unavailable before this feature cannot be reconstructed. See [Goal 3 milestone 1](docs/GOAL_3_MILESTONE_1.md) for scope and verification.

## Structured knowledge foundation

Goal 3's backend now persists project-owned design concepts, typed relationships, normalized chapter associations, decision supersession, question answers/reopening, and immutable provenance/change evidence. These APIs are ready for the next UI milestone; a Design Knowledge view and AI extraction are not yet implemented. See [Milestone 2 schema, APIs, and verification](docs/GOAL_3_MILESTONE_2.md). The existing question-resolution action now asks for its answer and uses revision checks.

## Optional AI connection

Manual editing works without any API key. To connect the Workshop:

```sh
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, restart Forge, and reload the browser. Settings in `.env` take precedence over inherited shell settings. Alternatively, set it in the backend process environment. Keys stay on the backend and are never returned to the browser, saved in SQLite, or committed to Git. The optional `OPENAI_MODEL` defaults to `gpt-4.1-mini` and must support streaming chat completions and strict structured outputs. Requests need outbound access to `api.openai.com` and incur your provider's normal API usage costs.

The Workshop builds bounded context from your project title and premise, Game Vision, the active chapter, relevant chapters, approved decisions, open questions, pending suggestions, and recent completed messages. Maturity labels distinguish approved direction from exploratory material. Each chapter retains its conversation across sessions.

Open **Design together** to explore a chapter, identify missing details, challenge a design, suggest improvements, or organize notes from the composer. These actions run contextual workflows immediately. You can also ask naturally for a chapter revision, a new chapter, a section addition or revision, a maturity change, or a meaningful decision or open question to record.

**Receiving or reviewing a proposal never changes the book.** Each proposal card opens a review with its target, intended change, reason, original snapshot, proposed content, and readable additions/removals. Requests to split the active chapter into sub-chapters generate nested creation proposals. **Place under** shows their parent before acceptance and can also place older standalone chapter proposals under the intended parent. The parent content stays intact unless you approve a separate revision. Accept or reject proposals individually. Accepted content changes receive Proposed maturity; a status proposal changes only maturity. Decision acceptance records an Approved choice; question acceptance records an Open uncertainty. The **Decisions & open questions** disclosure shows records linked to this chapter and lets you mark answered questions resolved.

Acceptance is transactional and checks the revision captured before the AI request. A chapter changed during or after generation cannot be overwritten: reject the old proposal or regenerate it, then review the fresh proposal. Rejection leaves chapter content, maturity, and records unchanged. If accepting one revision makes another proposal stale, regenerate the remaining proposal against the updated chapter.

AI section edits preserve all content and formatting outside the exact target heading. AI text is converted into rich headings, bold emphasis, simple lists, and code blocks. Existing unformatted Markdown paragraphs are repaired when opened and saved through the usual revision checks. Full replacements recreate the proposed formatting; review them carefully because prior formatting omitted from the proposal is not retained. Large active chapters are excerpted for conversation and permit section proposals rather than unsafe full replacements. Context selection uses character budgets and keyword relevance rather than semantic search; the assistant is informed when material was omitted. Stop an in-progress response to preserve partial conversation without generating actionable proposals.

## Local data and backup

Data lives in `data/forge.sqlite`, with SQLite WAL sidecars while running. The `data/` folder and `.env` are ignored by Git. To back up, stop Forge and copy the entire `data/` directory. Set `FORGE_DB_PATH` to use another database file. Stable UUIDs, foreign keys, and versioned migrations establish relationships between projects, chapters, conversations, messages, proposals, and design records. Existing databases migrate automatically at startup. A project's ordered chapters are its Design Book; no redundant book record is needed.

Do not run the app behind a public proxy. The API rejects non-loopback hostnames and external browser origins. `PORT` changes the backend's production port; the development proxy expects the default 4310 unless `vite.config.ts` is updated.

## Verification

```sh
npm test
npm run check
npm run build
```

Tests cover restart persistence, blank projects, chapter ordering, atomic proposal generation, section preservation, status and record approvals, rejection safety, stale revisions, bounded context, project isolation, malformed AI operations, streaming failures, and local-origin validation. Browser QA verifies contextual workflow execution, review, immediate editor refresh, decisions, stale proposal blocking, rejection, and conversation restoration using an isolated deterministic assistant. No live provider call is made by the test suite or this Goal 2 verification.

See [architecture and implementation increments](docs/architecture.md) for repository responsibilities and scope.
