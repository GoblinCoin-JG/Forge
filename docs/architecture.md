# Forge architecture and AI Workshop

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
  ai.ts                       Provider stream and structured response validation
  context.ts                  Bounded, project-scoped design context
shared/types.ts               Data contracts, validation, document utilities
tests/forge.test.ts           Foundation persistence and API behavior
tests/workshop.test.ts        Design operations, context isolation, conflicts
shared/diff.ts                Bounded readable proposal diff
```

Presentation state (selected project, open panel, search query, editor draft) lives in React. Domain records live in SQLite. The editor debounces saves and serializes requests; revision checks catch conflicting edits. Before navigation, Forge flushes outstanding saves. A failed save preserves the draft, warns on tab closure, and permits retry or explicitly discarding the draft to reload saved content.

## Data model

| Entity         | Relationships and purpose                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects       | UUID, working title, original premise, timestamps                                                                                                                          |
| Chapters       | Project FK, title, Tiptap JSON content, maturity, position, revision, timestamp                                                                                            |
| Conversations  | Project FK and unique chapter FK; one contextual conversation per chapter                                                                                                  |
| Messages       | Conversation FK, role, plain text, complete/failed/interrupted state, timestamp                                                                                            |
| Proposals      | Conversation and assistant-message FKs, project FK, optional target chapter FK, full proposed document, title, reason, captured revision, pending/accepted/rejected status |
| Design records | Project FK, decision/question, rationale, chapter links, approved/open/resolved state                                                                                      |
| Migrations     | Applied schema version and timestamp                                                                                                                                       |

Chapters have a nullable parent chapter FK. Parent assignments are validated within the project; cycles and self-parenting are rejected. Hierarchical numbering is derived from sibling order. Editing placement uses the same optimistic revision check as chapter text. Archiving a parent promotes its direct children one level while preserving descendant content and conversations.

The Design Book is the ordered collection of a project's live chapters. New projects receive only Game Vision. Chapter UUIDs are stable anchors for later cross-references, without a graph database. Chapter removal archives its row and preserves conversation, proposals, and source evidence. Archived chapters are excluded from current chapter context; explicit decisions retain their authority.

Migration 4 introduces immutable `chapter_revisions` and `chapter_approvals`, an approved-revision pointer, and archival metadata. Existing chapters become labeled migration baselines without rewriting their documents or revision numbers. Every document/maturity/placement save, restore, archive, and return captures a snapshot atomically; reorder changes only positions. Approval is an explicit action tied to a saved revision. Material title/document changes become unreviewed while retaining the earlier approval. Context uses the historical approved snapshot separately from newer drafts. Restoration appends a new unreviewed revision and retains current chapter placement. Historical JSON is rendered directly in a read-only Tiptap preview. See [milestone verification](GOAL_3_MILESTONE_1.md).

Proposal operations are create_chapter, create_subchapter, update_chapter, add_section, revise_section, change_status, record_decision, and record_question. The provider returns validated JSON, never executable instructions. All suggestions share a pending/accepted/rejected lifecycle. Proposed decisions are pending proposals; only accepted decisions become authoritative records. Open questions also require deliberate acceptance. Resolving a question is an explicit project-scoped action.

Generation captures the active chapter before the provider request. All generated proposals are validated and saved together with the completed reply in one transaction; any invalid target, foreign source, malformed section, or invalid status rolls back the entire batch. Each proposal stores the full original snapshot and revision independently of context excerpts. Backend validation binds target, source assistant message, conversation, and project, and checks every related chapter belongs to that project. Chapter modifications are restricted to the conversation's active chapter; creation stays within its project.

Acceptance occurs in an immediate SQLite transaction. A captured revision mismatch returns 409 and leaves the proposal pending and newer content intact. The UI disables stale acceptance and offers regeneration for a new review. Content changes receive Proposed maturity; status changes preserve title/content, and record proposals preserve all chapter data. Rejection only changes proposal state. Repeated review is rejected. Section revisions require one exact heading and replace its body through the next heading of equal or higher level; other nodes retain their rich-text JSON.

Migration 3 adds chapter/proposal parent relationships, preserving existing books as top-level chapters. A sub-chapter proposal is constrained to the active chapter as its parent. Acceptance only creates a child and never overwrites the parent, so multiple split proposals remain independently applicable. The human can choose another in-project destination during review, including for legacy standalone proposals.

Migration 2 adds operation metadata, original snapshots, chapter links, and design records without resetting existing data. Legacy proposal kinds are inferred from their target. Matching legacy revisions recover their original snapshot; already-stale legacy proposals remain blocked.

The centralized context builder reserves up to 32,000 characters for design excerpts and up to 8,000 for completed conversation text. It prioritizes the selected chapter and Game Vision, then up to four Approved chapters and three relevant drafts ranked by keyword overlap, with ancestors prioritized when discussing a sub-chapter. Context also identifies the active chapter’s parent path and existing children. It includes up to twelve relevant approved decisions/open questions and five pending proposal summaries. It labels maturity and truncation explicitly. Full chapter replacements are refused when the active chapter was excerpted, preventing accidental loss of omitted material. Full snapshots are used only for validation and review, never copied wholesale into the provider context.

## Implemented increments

1. **Local skeleton:** repository tooling, shared TypeScript contracts, SQLite migration, loopback API, and manual-use setup state.
2. **Design Book:** project creation/open/rename, optional initial idea, rich-text chapters, autosave, ordering, deletion, maturity, and responsive styled shell.
3. **AI Workshop:** backend-owned credentials, active and Approved design context, persisted conversation, streaming/cancellation, structured suggestions, comparison review, and transactional acceptance/rejection.
4. **Verification:** automated persistence and approval tests, browser workflow checks, production build/start checks, and operation documentation.

These are deliberately separate modules and verifiable increments, rather than infrastructure for future Forge subsystems. There are no Unity changes, coding agents, backlogs, assets, release workflows, cloud accounts, or collaboration.

## Goal 3 structured knowledge persistence

Migration 5 extends existing `design_records` and adds project-owned concepts, typed relationships, normalized concept/chapter and record associations, immutable change snapshots, and verified provenance. Concepts exist independently of chapters. A focused `Store.knowledge` domain module shares SQLite and the existing transaction boundary; `/api/projects/:projectId/knowledge` and scoped entity/lifecycle endpoints expose the model.

Milestone 3 adds a project-level Design Knowledge workspace and a compact chapter disclosure. Modular components in `client/components/knowledge/` handle concepts, relationships, decisions/questions, forms, and immutable evidence inspection. `client/knowledge.ts` loads existing APIs into transient project-scoped React state, rejects late responses after navigation, and refreshes after writes. Expected revisions remain mandatory; errors retain drafts. A committed write followed by a failed refresh is reported as saved, avoiding duplicate submissions. No frontend persistent knowledge store, schema migration, or AI extraction was added. One project-scoped read-only source-detail endpoint resolves original chapter revisions, Workshop messages, and accepted proposal metadata. See [Milestone 3 verification](GOAL_3_MILESTONE_3.md).

Exploring concepts/relationships are unreviewed; approval is explicit and material changes require renewed review. Symmetric relationships are canonicalized and active duplicates rejected; directed edges retain their direction. Concept archival atomically retires its incident edges. Decision statements are immutable and replaced through atomic supersession; questions retain answers and reopen history. Associations never synchronize chapter prose. Legacy record JSON is retained as evidence; normalized tables serve current associations, and unknown/missing legacy evidence is disclosed. The AI's authoritative decision list excludes superseded statements; relevant structured context can include them with explicit historical/non-authoritative state. See [Milestone 2 report and API inventory](GOAL_3_MILESTONE_2.md).

## Goal 3 AI knowledge integration

Migration 6 adds immutable knowledge proposal metadata, immutable applied-result references and normalized same-response dependencies to existing proposals. Existing document/record proposals remain compatible. Knowledge proposals use `kind: knowledge` with a discriminated payload `version: 1`; `shared/knowledge-proposals.ts` owns its validation/types. Provider strict JSON schema mirrors those operations. `server/knowledge-proposals.ts` captures original target snapshots, project-owned references and revisions before review, resolves new-concept keys only within the same response, and applies individually reviewed changes through KnowledgeStore inside the existing Store transaction. The backend generates all provenance; the model cannot supply ownership, historical evidence or approval state.

Review outcomes are explicit: concepts/relationships accept as Exploring or Approved; decisions require approval; questions, answers and retirement require acceptance. A dependent proposal never accepts its prerequisites. Accepted prerequisites must remain live at their recorded result revisions. Group acceptance is deferred. Failed validation/application/evidence/result persistence rolls back acceptance and knowledge together; repeated review is rejected. Accepted changes retain Workshop/message/proposal and source chapter revision references.

`KnowledgeProposalReview.tsx` renders original/proposed fields, associations, authority choices, dependency state and stale feedback without raw JSON. Accepted result links open concepts, a relationship's owning concept detail, or the matching record workspace with the result highlighted. The chapter-based Workshop and SSE transport remain in place. Structured context adds bounded chapter/name-ranked concepts, a single relationship hop and associated records, including explicitly historical decisions. Current user instructions remain complete; broader retrieval manifests and document-fidelity changes remain later work. See [Milestone 4 verification](GOAL_3_MILESTONE_4.md).

## Goal 3 document integrity

Milestone 5 shares `shared/document.ts` extensions between the live editor, read-only previews, and provider-independent validation. Validation checks supported nodes, attributes, marks, nesting, links, size, and depth against the actual Tiptap schema, while retaining the submitted JSON exactly. Automatic trailing-node insertion and editor-load Markdown conversion are disabled.

`shared/document-proposals.ts` defines the version 2 document envelope and materializes localized edits on the backend from the captured source revision. Creation/full updates carry complete documents; section operations carry rich block fragments and a unique heading selector. `shared/document-context.ts` supplies whole blocks and backend-owned coverage receipts. Full replacements require complete coverage; section revisions require the complete selected range. The provider schema mirrors these contracts without defining persistence or approval authority.

Migration 7 adds nullable immutable document metadata and protects canonical proposal content/source fields. Existing chapter snapshots, approvals, knowledge metadata, and legacy proposals are retained. Store acceptance revalidates scope and content and reuses transactional revision/history/provenance checks. Unsafe legacy full replacements require regeneration; safe stored creations and localized edits retain their exact saved content. `DocumentComparison.tsx` displays rich previews with structural, formatting, and link differences. Unsupported saved structures receive a retained-source read-only guard. See [Milestone 5 report](GOAL_3_MILESTONE_5.md) for contracts, acceptance audit, and verification.

## Goal 2 implementation

1. Reused the existing SQLite store, chapter revision checks, SSE adapter, editor flush, and chapter conversations.
2. Added centralized context selection, typed proposal operations, source/target validation, original snapshots, and atomic generation/review.
3. Added persistent design records, question resolution, contextual workflow modes, snapshot comparisons, readable diffs, stale blocking/regeneration, and project/chapter indicators.
4. Verified deterministic API and persistence tests, production compilation, and the browser conversation-to-approved-document workflow.

## Current limits

- Goal 2 verification uses a deterministic assistant and does not make a live provider call. Provider quality still depends on the configured model.
- Context uses character budgets and keyword overlap, not a tokenizer or semantic retrieval. Older conversations remain persisted but only recent completed messages are sent. There is no automatic conversation summarization or contradiction classifier; significant unresolved tensions can be proposed as open questions.
- AI document operations use canonical rich JSON validated against the actual editor schema. Whole-block excerpts permit localized operations when the complete target section is supplied; full replacements require complete source coverage. Legacy text conversion is confined to compatibility storage paths; newly generated text document operations are rejected. Opening documents never repairs Markdown automatically. Unsupported historical structures remain retained and disclosed rather than silently normalized.
- This remains a single-user local application. Concurrent browser edits are detected and rejected rather than merged. A hard crash before an autosave completes can lose unsaved draft text.
