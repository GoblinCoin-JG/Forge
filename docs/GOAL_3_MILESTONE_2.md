# Goal 3 — Milestone 2: Structured Knowledge Persistence

Date: 2026-10-11. Scope: backend persistence, domain integrity, validated APIs, and compatibility with the existing Design Book/Workshop. Work stops here for review before Milestone 3.

## 1. Migration and schema

Migration **5** follows the chapter-history migration. It is transactional, repeatable, and additive. Existing project/chapter IDs, document JSON, chapter revisions/approvals, conversations, messages, proposals, and design-record identifiers are retained.

| Table                                | Purpose and integrity                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design_concepts`                    | Stable project-owned identity; name/normalized name, extensible category, description, maturity, revision/approval reference, timestamps and archival state. A partial unique index prevents equal normalized names among active concepts in the same project. |
| `concept_chapters`                   | Many-to-many association. Composite foreign keys enforce that both concept and chapter belong to the recorded project. Concepts do not require a chapter.                                                                                                      |
| `design_relationships`               | Source/target concepts, validated type, rationale, maturity, revision, timestamps and retirement state. Same-project composite foreign keys, self-link prohibition, canonical symmetric ordering and active-edge uniqueness.                                   |
| `record_chapters`, `record_concepts` | Normalized associations for the existing decisions/questions, with project-aware foreign keys.                                                                                                                                                                 |
| `legacy_record_links`                | Preserves unresolved or foreign legacy chapter references with an explanation; these do not become valid associations.                                                                                                                                         |
| `knowledge_changes`                  | Immutable, revision-indexed snapshots for concepts, relationships and records. Each change identifies exactly one owned subject, operation, actor and timestamp. Captures associations as well as scalar fields.                                               |
| `knowledge_sources`                  | Immutable backend-validated provenance associated with changes. Typed manual, chapter/revision, Workshop, accepted proposal, or unknown legacy evidence. Sources are validated against project ownership and referenced records.                               |

The existing `design_records` table gains `revision`, `updated_at`, `superseded_by`, `resolution`, and `resolved_at`. Its original statements, rationale, IDs and status labels are preserved. SQL guards prevent editing approved decision statements/rationale and prevent clearing an established supersession link.

Legacy records receive migration-origin baseline changes and **unknown legacy provenance**. A related chapter is an association, not proof of where a statement originated: the migration does not guess a source revision, message, proposal, answer or resolution timestamp. Existing resolved questions with no recorded answer remain resolved with an unknown answer. Valid chapter links are normalized; invalid/missing references remain inspectable. The old `related_chapter_ids` JSON is retained as legacy/creation evidence, while runtime association reads and mutations use normalized tables exclusively.

Implementation: `server/knowledge-migration.ts`; invoked by `server/db.ts` after migration 4. Schemas/types: `shared/knowledge.ts`, extended `shared/types.ts`.

## 2. Domain operations and API inventory

`Store.knowledge` provides a focused `KnowledgeStore` using the same database and existing Store transaction boundary. Its operations do not maintain another document store or rewrite chapter prose. No new service or framework was introduced.

All paths below are under `/api/projects/:projectId`. Updates/actions require the target's current integer `revision`; association setters replace the supplied sets atomically, supporting both linking and unlinking. The server generates IDs, timestamps, change evidence and actor classification. Payloads reject unknown fields.

| Method and path                    | Operation                                                                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /knowledge`                   | Retrieve concepts, relationships and design records. Default excludes archived concepts, retired relationships and superseded decisions; resolved questions remain available with their state. `includeHistorical=true` includes historical entities. |
| `GET /concepts`                    | Browse/search names with `q`; optional `includeHistorical=true`.                                                                                                                                                                                      |
| `POST /concepts`                   | Create an Exploring concept, independently of chapters.                                                                                                                                                                                               |
| `GET /concepts/:id`                | Retrieve concept, maturity, associations and sources, including an archived concept by ID.                                                                                                                                                            |
| `PATCH /concepts/:id`              | Update name/category/description or exploratory maturity with optimistic concurrency. Cannot approve through this payload.                                                                                                                            |
| `POST /concepts/:id/approve`       | Explicitly approve the current version.                                                                                                                                                                                                               |
| `POST /concepts/:id/archive`       | Archive and atomically retire incident active relationships, preserving evidence.                                                                                                                                                                     |
| `POST /concepts/:id/restore`       | Restore as unreviewed; optional replacement name resolves a collision without changing identity.                                                                                                                                                      |
| `PUT /concepts/:id/chapters`       | Set `chapterIds` with revision checking.                                                                                                                                                                                                              |
| `GET /concepts/:id/history`        | Inspect immutable changes and sources.                                                                                                                                                                                                                |
| `GET`, `POST /relationships`       | List or create typed relationships. Creation is Exploring. Historical listing is optional.                                                                                                                                                            |
| `GET`, `PATCH /relationships/:id`  | Inspect or update endpoints/type/rationale/exploratory maturity.                                                                                                                                                                                      |
| `POST /relationships/:id/approve`  | Explicitly approve a relationship with live endpoints.                                                                                                                                                                                                |
| `POST /relationships/:id/retire`   | Retire without deleting history.                                                                                                                                                                                                                      |
| `GET /relationships/:id/history`   | Inspect durable relationship evidence.                                                                                                                                                                                                                |
| `POST /decisions`                  | Explicit manual creation of an approved, binding decision statement.                                                                                                                                                                                  |
| `POST /questions`                  | Create an open question.                                                                                                                                                                                                                              |
| `GET /records`, `GET /records/:id` | Existing project record collection and new individual inspection, including historical state.                                                                                                                                                         |
| `PUT /records/:id/links`           | Set `chapterIds` and `conceptIds`; keep statement/rationale unchanged.                                                                                                                                                                                |
| `GET /records/:id/history`         | Inspect prior associations, supersession state, answers and provenance.                                                                                                                                                                               |
| `POST /decisions/:id/supersede`    | Atomically create a replacement decision and mark the previous decision superseded. Associations are inherited unless explicitly replaced.                                                                                                            |
| `POST /questions/:id/resolve`      | Resolve using required `revision` and nonempty `answer`; returns the project record array for compatibility.                                                                                                                                          |
| `POST /questions/:id/reopen`       | Explicit reopening; earlier resolution remains in history.                                                                                                                                                                                            |

Sources accepted on manual operations are `{kind:"manual"}`, `{kind:"chapter",chapterId,revision}`, or `{kind:"workshop",conversationId,messageId?}`. Chapter revisions must exist and belong to the project. Workshop messages must be complete and belong to the supplied owned conversation. The operation remains a manual action citing evidence; it is not classified as AI approval.

Clients cannot supply an accepted-proposal or legacy provenance classification. The existing record-proposal review path now commits proposal acceptance, record creation, normalized links and verified proposal/message/chapter-revision provenance in the same transaction. A provenance failure rolls back acceptance; repeated application cannot create duplicate records. No new knowledge-extraction proposal kind was added.

## 3. Authority and lifecycle

- Concepts and relationships start **Exploring**, not authoritative. Explicit approval sets **Approved**. Material edits to approved content become **Needs Revision**; approval evidence stays in history. Changing concept chapter associations also requires renewed approval when the set actually changes.
- Concept normalization uses Unicode NFKC, trimming, whitespace collapse and lowercase. Similar names are not merged. Archived names may be reused, but restoration must satisfy active-name uniqueness.
- `depends_on`, `affects`, and `part_of` are directional: source → target. `interacts_with` and `conflicts_with` are symmetric; endpoints are stored in deterministic order so reverse declarations are duplicates. Distinct types are allowed between the same subjects. Retired edges no longer reserve an active-edge identity; a subsequent relationship has its own ID/history.
- Archived concepts cannot be updated/approved or form new active relationships. Archival retires existing incident relationships transactionally. Restoration does not silently reactivate those relationships or restore authority.
- A decision is authoritative only when it is an approved, unsuperseded decision. Its approved statement/rationale is immutable; replacing either requires a new decision. Superseded records remain inspectable and are excluded from the existing AI context's authoritative decisions. Updating metadata/associations does not rewrite the binding statement.
- Questions are never authoritative decisions. Resolving stores an answer and timestamp; reopening clears the current resolution while retaining immutable prior answers. These actions never create or supersede a decision.
- Neither chapter edits nor archival automatically change structured statements. Structured edits never save chapter prose. Existing links to archived subjects remain historical associations; new associations require live targets. Unlinking existing historical associations is allowed with a revision check.
- Source availability is exposed as **available**, **historical**, **missing**, or **unknown**. Changing/archiving a source chapter does not erase its revision or revoke a separately approved decision.

Current manual decision creation is explicitly authoritative through the `/decisions` action. Exploratory-versus-authoritative AI proposal review and dependent/grouped knowledge proposals remain for the later AI milestone; the existing reviewed record proposal behavior is preserved.

## 4. Verification

Commands:

```powershell
npm run check
& 'C:\Users\garne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --import tsx --test --test-isolation=none tests/*.test.ts
npm run build
```

The shell's Node 22 is below the declared supported server runtime; bundled Node 24.19.0 was used for tests. Final results: **73 tests passed, 0 failed/skipped**, TypeScript passed, production build passed. Vite retains its existing large-bundle warning.

There are 20 new knowledge tests in `tests/knowledge.test.ts`, alongside all 53 prior regression tests. They exercise:

- Concept lifecycle, Unicode normalization, active-name uniqueness and conflicting restoration.
- All relationship types, symmetric/directional duplicates, revision evidence, retirement and archival of incident edges.
- Many-to-many concept/chapter and record/concept associations, unlinking, archived associations and unchanged chapter documents.
- Project boundaries, stale revisions and strict API validation across mutation families.
- Immutable decision statements, atomic supersession, retained historical authority evidence, and current-context filtering.
- Question answers, reopening, resolution history and separation from decisions.
- Exact chapter/Workshop citations, source ownership, invalid/forged provenance, and accepted record-proposal evidence.
- Injected failures proving rollback of supersession, concept archival/relationship retirement, association mutations and proposal acceptance/provenance.
- SQL foreign-key/immutability guards; migration repeatability, failure rollback/retry, valid/missing/foreign legacy references; database close/reopen recovery.

An integration test starts a real Fastify server on an ephemeral loopback port and uses HTTP Fetch requests to create/approve/link/retrieve knowledge, stream a deterministic Workshop answer, accept its existing record proposal, supersede a decision, and resolve/reopen a question. This tests actual HTTP route wiring and persistence together, not just domain methods or injected requests.

Verification used only in-memory and disposable temporary databases, including a reconstructed version-4 fixture. No live OpenAI call was made. One intermediate test/type-check run failed due to a redeclared fixture variable introduced during cleanup; it was fixed and the entire suite rerun successfully.

## 5. Architectural deviations and compatibility

No deviation from project-owned concepts, SQLite, additive migrations, normalized associations or human authority. New domain code is isolated in `server/knowledge-store.ts` and route registration in `server/knowledge-routes.ts`, rather than adding all operations to the existing large Store/API files. They share the same transaction and error conventions.

One deliberate API tightening: the existing question-resolution action now requires a revision and answer. Accepting `{}` would bypass stale protection and lose the requested resolution evidence. Its URL and successful array response are retained. The existing Workshop action now collects an answer and sends its revision; superseded decisions are labeled accordingly. These are small compatibility adjustments, not the project-level knowledge UI or extraction workflow. The older resolution regression test now supplies the required evidence.

## 6. Known risks and incomplete work

- This completes **Milestone 2**, not all of Goal 3. No project-level Design Knowledge view, concept detail panels, relationship UI, AI extraction or grouped proposal review was implemented.
- The actual user's database was not used for a migration rehearsal. Startup applies migration 5 when the updated backend opens a database lacking it; compatibility was verified with disposable legacy fixtures.
- Legacy provenance cannot be recovered where it was never recorded. Missing/foreign legacy references are preserved and flagged, not silently linked or repaired.
- Broader structured AI retrieval, complete current instructions, context manifests and AI document fidelity remain later milestones. This change only prevents superseded decisions from being treated as current authority.
- No live-provider or browser UI workflow was tested in this backend milestone. The existing Workshop compatibility changes were type-checked and included in the production build; the HTTP integration uses a deterministic assistant.
- Retrieval/history currently loads complete project collections and evidence lists with multiple SQLite lookups. No pagination, retention policy or large-project performance benchmark is claimed. Read performance should be measured before introducing more infrastructure.
- Longer relationship cycles are not classified or automatically resolved; only self-links and duplicate edges are rejected. Future retrieval must use bounded traversal and explicit conflict handling. Local trust/authentication scope remains unchanged.

## 7. Recommendations for Milestone 3

1. Add the approved lightweight project-level Design Knowledge view for browse/search, maturity, associated chapters, relationships, decisions/questions and manual editing.
2. Add a contextual chapter knowledge disclosure and concept details, using stable concept IDs and the normalized associations.
3. Show current versus historical authority and provenance clearly, including archived sources, unknown legacy evidence, superseded decisions and prior question answers.
4. Provide explicit approval, archival/return, supersession and resolution interactions with stale-error recovery; do not treat ordinary concept creation as approval.
5. Verify those interactions in the actual browser with disposable fixture data. Keep AI extraction and graph editing outside that UI milestone unless separately authorized.

Milestone 2 stops here and awaits review.
