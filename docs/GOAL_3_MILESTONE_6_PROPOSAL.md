# Milestone 6 architectural proposal

Status: approved with the developer's refinements on October 11, 2026. Implementation includes configurable byte/token budgets, recent-exchange reservation, full provider-request digests and format metadata, recovery/storage measurements, exact supplied-source explanations, and explicit Game Vision correction. Based on inspection of the post-Milestone-5 repository.

## Existing behavior and gaps

`server/context.ts` supplies canonical document excerpts and the active chapter's Milestone 5 coverage receipt. It ranks chapters by limited text overlap, selects concepts associated with the active chapter, and includes a single relationship hop. Current user instructions are preserved by the existing API limit. Approved chapter history, normalized knowledge associations, immutable knowledge change snapshots, and project-owned conversations already exist.

The aggregate budget counts selected text and document JSON but omits much metadata and recent messages. Concept selection tends to include the first twenty concepts even without relevance. Approved concept/relationship snapshots are not retrieved separately from newer exploratory changes. Earlier project conversation is not searched. Game Vision is identified by its current title. Source data is embedded inside the provider's system message. Responses do not retain the actual request context or expose its source selection.

## Retrieval architecture

Keep the chapter-scoped Workshop, Fastify/SQLite store, existing OpenAI adapter, and validated proposal contracts. Separate provider-independent retrieval into focused modules for project inventory, ranking/traversal, section selection, authority resolution, budgeting, and manifest construction. Keep `buildContext` as the integration entry point, with a typed result containing the selected model context and its backend-owned manifest. Provider formatting consumes this result without selecting or trimming additional sources.

Build a compact project inventory of chapter hierarchy and section headings, live concept names/categories/maturity/associations, documented relationships, approved decision labels, and outstanding questions. Include stable IDs and revisions so the assistant can reuse existing subjects. Do not load every chapter body. Large inventories are deterministically budgeted, with omitted categories/counts and relevant omitted sources explicitly disclosed.

Rank detail candidates using explicit UUID/name references, the complete current message, active chapter/section text, normalized associations, and lexical matching across section headings and bodies. Use Unicode-normalized tokens, phrase matches, bounded frequency scoring, and deterministic ID tie-breakers. Selection should find subjects mentioned in content rather than only in titles. Matching is an approximation of semantic relevance, not a claim of embeddings or semantic search.

Traverse documented relationships breadth-first from relevant concept seeds, with explicit incoming/outgoing direction for directed relationships and symmetric handling for `interacts_with`/`conflicts_with`. Proposed starting caps: two hops, forty detailed concepts, sixty edges. Relevance decides whether the second hop is useful. Visited sets prevent cycles and duplicate sources; traversal/selection limits are reported. Retrieval never writes concepts or relationships. Include documented edge type, direction, maturity, and inclusion reason; inferred connections can only appear as explicitly unapproved assistant suggestions.

## Authority and continuity

Supply current approved unsuperseded decisions as active choices. Retrieve exact approved chapter versions separately from newer unreviewed content. Retrieve the last approved concept/relationship snapshots from immutable knowledge history alongside newer live versions when relevant. A past approval is usable as previously approved evidence but does not silently make a renamed, edited, archived, retired, or superseded entity currently authoritative. Backend labels distinguish current approval, prior approval with unreviewed changes, exploration, unresolved questions, resolved answers, superseded decisions, and archived/retired history.

Prioritize relevant unresolved questions and relevant approved direction. Retrieve historical/superseded/resolved sources for explicit history questions, lexical relevance, and meaningful source evolution. Do not infer approval from prose. Prompts require the assistant to explain discrepancies between narrative and approved structured knowledge and seek human direction before proposing changes.

Use persistent structured knowledge as durable memory. Supply complete recent messages within budget and selectively retrieve earlier complete messages from this project's chapter conversations by explicit references and relevance. Label conversation evidence with its original chapter, message, role, and time; it is discussion, not an approved decision. Exclude failed/interrupted messages from design evidence. Do not implement summaries in this milestone; unavailable evidence stays unavailable.

## Section retrieval and editing safety

Extend the existing section index to expose heading hierarchy, transient block ranges, chapter ID, and exact revision. Prefer complete relevant rich sections, with overlapping ranges deduplicated. Retain supported formatting, URLs, code, and nested lists exactly. If a section cannot fit, supply only whole blocks with explicit incomplete coverage or omit it entirely; never cut text or JSON mid-node.

The active chapter's coverage receipt must describe the exact final context after budgeting. A full replacement still requires the complete saved source. A localized revision still requires its complete unique target section. Extra retrieved chapter/history evidence does not authorize editing a different chapter or using an older approved snapshot as the current edit source. Missing context blocks proposals through the existing server checks. No permanent section IDs are introduced; section references are revision-specific heading paths and block ranges.

## Budgeting and measurements

Budget actual UTF-8 JSON bytes, including selected metadata, documents, messages, coverage, and provider formatting. Proposed initial limits: 128 KiB for serialized source/context data and 192 KiB for the complete serialized provider request including instructions/schema. These are byte limits, not asserted token counts. Measure framing/schema overhead and reserve it before selecting sources; reject an impossible request clearly rather than trimming the developer's current message. The existing 20,000-character current-message limit remains, with explicit oversize rejection.

Reserve the complete current message first, then project identity, relevant approved direction, active edit source/selected section, compact discovery inventory, associated knowledge, relationship details, other sections, recent conversation, and older/history evidence. Allocate flexible category shares and release unused space. Detailed sources compete by relevance and authority, not database order. Whole items are retained whenever possible; partial fields require explicit coverage information. Recompute final size and receipts before dispatch, then freeze the request snapshot. Equivalent inputs produce stable selection and source order; timestamps and measured duration are diagnostics only.

Benchmark small, medium, and representative large fixtures, including hundreds of chapters, thousands of concepts/relationships, long rich documents, large conversation histories, and maximum-length Unicode instructions. Report actual request bytes, retrieval time, selected/omitted counts, and expected relevant-source recall. Tune limits using these measurements without adding external infrastructure.

## Manifest and interface

The manifest is generated before dispatch from the actual final selected context. It includes a version, project/active chapter IDs, workflow, budgets and measured sizes, selected source identifiers/revisions, source kind/label, maturity/authority, complete/partial/overview-only coverage, section paths/block ranges where applicable, and concise inclusion reasons. Significant omissions include reason, category/count, and specific relevant sources when practical. Overview coverage is distinct from full detail coverage. A digest ties the manifest to the exact stored context payload; it contains no credentials, environment configuration, or model-generated authority.

Each assistant response, including failed/interrupted attempts that reached dispatch, links to its captured request. Older responses show that context was not recorded rather than reconstructing it. A compact expandable **Context Used** disclosure shows included sources, authority, coverage, reasons, and significant omissions. A bounded source list can expand further without overwhelming the conversation. Source inspection opens the exact historical chapter/knowledge version or original conversation evidence; navigation also offers the current chapter/concept through existing views. Archived/deleted/unavailable sources receive an explicit availability label. Navigation flushes pending editor saves through existing controls.

## Additive persistence and API changes

Migration 8 will add immutable request snapshots and response associations, without changing historical content:

- `workshop_context_requests`: request ID, project/chapter/user-message ownership, manifest version, exact bounded context JSON, manifest JSON, digest, timestamp.
- `workshop_response_contexts`: assistant-message-to-request association, with ownership checks and immutability protections.
- `project_context_anchors`: stable Game Vision chapter association and origin metadata. New projects anchor their initial chapter. Legacy projects use unique historical initial-vision evidence where available; ambiguous evidence remains unassigned and disclosed. A title rename does not change an established anchor. Archival is disclosed rather than silently switching to another similarly named chapter.

Persist the frozen request before provider dispatch. On response completion, save its association atomically with the response/proposals; failures/interruption retain the request evidence and link the saved failed/interrupted response. Startup migration is transactional and repeatable. Existing responses have no fabricated manifests.

The Workshop read API gains a lightweight per-response manifest reference/summary. Add project-scoped read-only manifest/source inspection endpoints; fetch full disclosures on demand to avoid returning every stored payload with conversation history. Source lookup validates ownership and serves captured material, not a reconstruction of current state. Exact request payload is retained locally for integrity and inspection, but is not exposed as raw diagnostic JSON in the normal UI. No AI-generated output contract changes: knowledge V1 and document V2 proposals remain intact. The internal provider input format changes to structured, labeled source data in a separate lower-priority message.

## Prompt boundary

Keep invariant instructions in the system message. Serialize retrieved project documents and earlier conversation evidence as labeled untrusted data in a separate message. The current developer message remains intact as the current user request. Retrieved strings cannot set system roles, source authority, approval, tools, or ownership. The adapter must not re-promote retrieved text into system instructions. Deterministic transport tests inspect this boundary; server validation/human approval continue to enforce changes independently of model behavior.

## Implementation and verification increments

1. Typed retrieval/manifest contracts, inventory, authority snapshots, section ranking, graph traversal, and serialized budgeting with focused tests.
2. Migration, frozen request persistence, scoped inspection APIs, failure handling, and restart/rollback tests.
3. Provider formatting boundary and unchanged knowledge/document proposal integration tests.
4. Context Used UI, historical source inspection/navigation, and frontend regression tests.
5. Representative performance/coverage measurements, actual disposable browser workflows, real adapter transport verification, complete tests/typecheck/build, and the required eight-part completion report.

Acceptance covers all eleven Milestone 6 completion criteria, including beyond-current-chapter retrieval, reuse of existing concepts, approved/historical distinctions, exact section coverage, complete current instructions, actual manifests/omissions, continuity, project isolation, prompt boundary, and large-project measurements. Stop after Milestone 6 for review. No vectors, summaries, autonomous actions, permanent section IDs, graph UI, new agent framework, or Milestone 7 implementation are proposed.

## Approval requested

Milestone 6 §15 requires approval for choices that materially alter AI contracts or persistence. Approve this retrieval approach, new immutable request/manifest tables, stable Game Vision association, scoped source inspection APIs, and separation of retrieved data from system instructions. Existing stored history and proposal output contracts remain preserved.

## Verified baseline and acceptance plan

Before implementation, the current worktree passes all 117 regression tests and TypeScript checks using Node 24.19.0. The only uncommitted file is this proposal. These results establish the starting baseline; they do not prove Milestone 6 retrieval or transparency.

| Completion criterion | Planned direct evidence |
| --- | --- |
| Retrieve beyond the active chapter | Fixture with a relevant section in a differently named chapter; exact source/revision and rich nodes in captured provider input |
| Existing concepts and relationships influence discussion | Existing Extraction concept reuse, directed/symmetric graph fixtures, cycle/hop caps, and browser conversation using documented relationships |
| Approved decisions prioritized | Competing relevant approved/exploratory candidates under a constrained budget, with exact ordered inclusion and omission assertions |
| Historical/exploratory information distinguished | Edited approved concepts/relationships/chapters plus superseded decisions; snapshot, authority, revision, and provider-boundary assertions |
| Canonical sections retrieved safely | Complete nested rich section selection, duplicate headings, oversized blocks, overlap deduplication, and existing approval coverage rejection |
| Current message never silently truncated | Maximum ASCII/Unicode instructions, transport equality, and explicit oversize rejection before dispatch |
| Workshop discloses actual sources | Persisted pre-dispatch context digest, captured transport comparison, historical inspection, and actual Context Used browser navigation |
| Significant omissions visible | Category/limit exclusions, relevant oversized sources, manifest accuracy, and browser partial-context disclosure |
| Existing proposals/editing functional | Complete document and knowledge proposal regression suites plus browser rich acceptance/extraction after context integration |
| Representative scale | Measured small/medium/large deterministic fixtures, serialized request bytes, retrieval latency, and seeded relevant-source coverage |
| Complete experience verified | Migration/rollback/restart/isolation/frontend/transport tests, disposable browser workflows, final full regression/type/build checks |

Additional adversarial checks will place role-like and approval-overriding strings in chapters, concept descriptions, and older conversations. The actual provider request must keep those strings in the labeled source-data boundary, preserve backend-controlled authority, and retain server ownership/human-review enforcement. Manifest snapshot and source-inspection APIs will be tested across projects, including rejected foreign IDs and stale/current-source differences.

