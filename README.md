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

Create a game project with an optional title and optional idea. Forge opens its Design Book with one **Game Vision** chapter; your idea becomes the initial chapter text. Blank projects are supported. Add other chapters when you need them.

Use the document toolbar for headings, emphasis, lists, quotes, and links. Edits autosave after a short pause. Click the save indicator or press Ctrl/Cmd+S to save immediately. Navigation waits for pending saves; failed saves keep your edits in the editor and offer retry or explicit reload. Reorder chapters using the arrows beside a sidebar chapter. Rename chapters by editing their title; rename the project through Project details.

Maturity can be Exploring, Proposed, Approved, or Needs Revision. These are design decisions and do not imply Unity implementation. Ctrl/Cmd+K searches projects and the active project's chapter titles. The Workshop can be hidden; small screens stack it below the document.

## Optional AI connection

Manual editing works without any API key. To connect the Workshop:

```sh
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, restart Forge, and reload the browser. Alternatively, set it in the backend process environment. Keys stay on the backend and are never returned to the browser, saved in SQLite, or committed to Git. The optional `OPENAI_MODEL` defaults to `gpt-4.1-mini` and must support streaming chat completions and strict structured outputs. Requests need outbound access to `api.openai.com` and incur your provider's normal API usage costs.

The Workshop supplies project details, the active chapter, other Approved chapters, and up to 30 completed messages from the active chapter's conversation. Conversations and proposals persist locally. The assistant may propose a full chapter revision or an additional chapter. **Reviewing or receiving a proposal never changes the book.** Acceptance applies the proposal transactionally and marks chapter maturity Proposed; the director can subsequently mark it Approved. Rejection does not modify chapter data. Proposals based on an older chapter revision cannot overwrite newer manual edits.

A proposed revision replaces the chapter's complete text and title; the review dialog shows current and proposed content. AI proposals currently use plain paragraphs, so accepting a replacement does not preserve rich-text formatting. Conversations remain independent of future coding-agent execution. Stop an in-progress response to preserve the partial conversation without applying proposals.

## Local data and backup

Data lives in `data/forge.sqlite`, with SQLite WAL sidecars while running. The `data/` folder and `.env` are ignored by Git. To back up, stop Forge and copy the entire `data/` directory. Set `FORGE_DB_PATH` to use another database file. Stable UUIDs, foreign keys, and versioned migrations establish relationships between projects, chapters, conversations, messages, and proposals. A project's ordered chapters are its Design Book; no redundant book record is needed.

Do not run the app behind a public proxy. The API rejects non-loopback hostnames and external browser origins. `PORT` changes the backend's production port; the development proxy expects the default 4310 unless `vite.config.ts` is updated.

## Verification

```sh
npm test
npm run check
npm run build
```

Tests cover database restart persistence, blank projects, chapter ordering, review transactions, rejection safety, stale revisions, cascades, contextual streaming through a controlled adapter, AI failures, target isolation, and local-origin validation. No live provider call is made by the test suite. Browser QA covered the manual workflow and responsive layout; live provider verification requires your API key.

See [architecture and implementation increments](docs/architecture.md) for repository responsibilities and scope.
