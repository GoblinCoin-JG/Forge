# Goal 1 foundation

## Architecture

Forge runs on the director's computer. React and TypeScript render the browser interface; Vite supplies development tooling and builds static assets. Fastify owns validation, persistence, AI credentials, and streamed conversations. SQLite is the durable source of truth. The backend serves the built interface in production; Vite proxies `/api/` in development. Both listen on loopback.

The requested React/TypeScript/Vite/Fastify/SQLite stack is retained. Two bounded implementation choices differ from the recommendations:

- CSS design tokens and accessible semantic controls replace Tailwind/shadcn. This app has a small UI surface, native dialogs, and Tiptap editing, so a second component/styling framework adds little value. The supplied visual guide controls colors, typography, surface hierarchy, and responsive behavior.
- Node 24's built-in SQLite driver avoids native dependency compilation and requires Node 24+. All database access is isolated behind the store, leaving room to change the driver without changing the browser API.

OpenAI is accessed directly from the backend via the streaming Chat Completions API with strict structured output. This is conversational game-design assistance, not a coding agent. A replaceable assistant function supports deterministic tests. Browser streaming uses SSE frames over a POST response; browser AbortController cancellation propagates to the provider request. No credentials are requested or persisted through the frontend.

## Repository

```text
client/
  App.tsx                     Project home, navigation, dialogs
  api.ts                      REST and streamed SSE client
  style.css                   Visual tokens and responsive workbench
  components/
    ChapterEditor.tsx         Tiptap editor and serialized autosaves
    Workshop.tsx              Conversations and proposal review
    Modal.tsx                 Native modal dialog and focus behavior
server/
  index.ts                    Local startup and optional environment config
  app.ts                      Validated REST endpoints and chat stream
  db.ts                       SQLite setup and versioned migration
  store.ts                    Persistent operations and review transactions
  ai.ts                       Context, provider stream, structured proposals
shared/types.ts               Data contracts, validation, document utilities
tests/forge.test.ts           Persistence, approval, and API behavior
```

Presentation state (selected project, open panel, search query, editor draft) lives in React. Domain records live in SQLite. The editor debounces saves and serializes requests; revision checks catch conflicting edits. Before navigation, Forge flushes outstanding saves. A failed save preserves the draft, warns on tab closure, and permits retry or explicitly discarding the draft to reload saved content.

## Data model

| Entity | Relationships and purpose |
| --- | --- |
| Projects | UUID, working title, original premise, timestamps |
| Chapters | Project FK, title, Tiptap JSON content, maturity, position, revision, timestamp |
| Conversations | Project FK and unique chapter FK; one contextual conversation per chapter |
| Messages | Conversation FK, role, plain text, complete/failed/interrupted state, timestamp |
| Proposals | Conversation and assistant-message FKs, project FK, optional target chapter FK, full proposed document, title, reason, captured revision, pending/accepted/rejected status |
| Migrations | Applied schema version and timestamp |

The Design Book is the ordered collection of a project's chapters. New projects receive only Game Vision. Chapter UUIDs are stable anchors for later cross-references, without a graph database. Chapter deletion cascades its conversation and proposals.

Proposal acceptance occurs in an immediate SQLite transaction. Revisions use the captured chapter revision, so newer edits produce a conflict and leave the proposal pending. Addition creates a new chapter. Either sets maturity Proposed, separate from the act of accepting an AI edit. Rejection only changes proposal status. Repeated review is rejected. The provider can propose a new chapter or change the active chapter; unrelated targets are rejected before any proposals are saved.

## Implemented increments

1. **Local skeleton:** repository tooling, shared TypeScript contracts, SQLite migration, loopback API, and manual-use setup state.
2. **Design Book:** project creation/open/rename, optional initial idea, rich-text chapters, autosave, ordering, deletion, maturity, and responsive styled shell.
3. **AI Workshop:** backend-owned credentials, active and Approved design context, persisted conversation, streaming/cancellation, structured suggestions, comparison review, and transactional acceptance/rejection.
4. **Verification:** automated persistence and approval tests, browser workflow checks, production build/start checks, and operation documentation.

These are deliberately separate modules and verifiable increments, rather than infrastructure for future Forge subsystems. There are no Unity changes, coding agents, backlogs, assets, release workflows, cloud accounts, or collaboration.

## Current limits

- No live OpenAI call was verified in this environment because credentials are not configured. The provider adapter and review workflow are tested with deterministic responses.
- Context currently includes complete documents, with recent conversation history capped at 30 messages. Very large books can exceed the selected model's context; token-aware context selection is a future refinement.
- AI revisions use plain paragraphs and replace the full document. Manual rich-text formatting is supported; AI proposals do not retain it.
- A hard browser/process crash before an autosave completes can lose the unsaved draft. Completed saves persist; normal navigation flushes and tab closure warns about pending changes.
- This release is a single-user local application. Concurrent browser edits are detected, not collaboratively merged.
