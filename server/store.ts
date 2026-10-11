import { isDescendant } from "../shared/chapter-tree.js";
import { designTextDoc } from "../shared/design-text.js";
import { changeSchema, type Answer } from "./ai.js";
import { randomUUID } from "node:crypto";
import { sameChapterContent } from "../shared/chapter-content.js";
import { KnowledgeStore } from "./knowledge-store.js";
import type { DatabaseSync } from "node:sqlite";
import {
  textDoc,
  type Chapter,
  type ChapterRevision,
  type Doc,
  type Maturity,
  type Message,
  type Project,
  type Proposal,
  type Workshop,
  type DesignRecord,
  docText,
  docSchema,
} from "../shared/types.js";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Row = Record<string, any>;
const now = () => new Date().toISOString();
const chapter = (r: Row): Chapter => ({
  id: r.id,
  projectId: r.project_id,
  parentId: r.parent_id ?? null,
  title: r.title,
  content: JSON.parse(r.content),
  status: r.status,
  position: r.position,
  revision: r.revision,
  updatedAt: r.updated_at,
  approvedRevision: r.approved_revision ?? null,
  approvedAt: r.approved_at ?? null,
  changedSinceApproval:
    r.approved_content != null &&
    !sameChapterContent(
      { title: r.title, content: JSON.parse(r.content) },
      { title: r.approved_title, content: JSON.parse(r.approved_content) },
    ),
  archivedAt: r.archived_at ?? null,
});
const chapterSelect = `SELECT c.*, a.approved_at, h.title approved_title, h.content approved_content
  FROM chapters c LEFT JOIN chapter_approvals a ON a.chapter_id=c.id AND a.revision=c.approved_revision
  LEFT JOIN chapter_revisions h ON h.chapter_id=c.id AND h.revision=c.approved_revision`;
const message = (r: Row): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  state: r.state,
  createdAt: r.created_at,
});
const proposal = (r: Row): Proposal => ({
  id: r.id,
  conversationId: r.conversation_id,
  messageId: r.message_id,
  projectId: r.project_id,
  chapterId: r.chapter_id,
  parentId: r.parent_id ?? null,
  title: r.title,
  content: JSON.parse(r.content),
  reason: r.reason,
  baseRevision: r.base_revision,
  status: r.status,
  createdAt: r.created_at,
  kind: r.kind,
  description: r.description || r.reason,
  section: r.section,
  proposedStatus: r.proposed_status,
  relatedChapterIds: JSON.parse(r.related_chapter_ids),
  before: r.before_snapshot ? JSON.parse(r.before_snapshot) : null,
});

export class Store {
  readonly knowledge: KnowledgeStore;
  constructor(public db: DatabaseSync) {
    this.knowledge = new KnowledgeStore(this);
  }
  private inTransaction = false;
  transaction<T>(fn: () => T): T {
    // Domain operations compose inside the outer approval/creation transaction.
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  projects(): Project[] {
    return (
      this.db
        .prepare(
          `SELECT p.*, (SELECT count(*) FROM chapters c WHERE c.project_id=p.id AND c.archived_at IS NULL) chapter_count FROM projects p ORDER BY updated_at DESC`,
        )
        .all() as Row[]
    ).map((r) => ({
      id: r.id,
      title: r.title,
      premise: r.premise,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      chapterCount: r.chapter_count,
    }));
  }
  project(id: string) {
    const p = this.projects().find((p) => p.id === id);
    if (!p) throw new AppError(404, "Project not found");
    return p;
  }
  touch(id: string) {
    this.db
      .prepare("UPDATE projects SET updated_at=? WHERE id=?")
      .run(now(), id);
  }
  createProject(title: string, premise: string) {
    const id = randomUUID(),
      date = now();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO projects VALUES (?,?,?,?,?)")
        .run(id, title || "Untitled game", premise, date, date);
      this.createChapter(id, "Game Vision", textDoc(premise));
    });
    return this.project(id);
  }
  updateProject(id: string, title: string, premise: string) {
    this.project(id);
    this.db
      .prepare(
        "UPDATE projects SET title=?, premise=?, updated_at=? WHERE id=?",
      )
      .run(title || "Untitled game", premise, now(), id);
    return this.project(id);
  }
  chapters(id: string, archived = false) {
    this.project(id);
    return (
      this.db
        .prepare(
          `${chapterSelect} WHERE c.project_id=? AND c.archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY c.position, c.id`,
        )
        .all(id) as Row[]
    ).map(chapter);
  }
  chapter(id: string, includeArchived = false) {
    const r = this.db.prepare(`${chapterSelect} WHERE c.id=?`).get(id);
    if (!r) throw new AppError(404, "Chapter not found");
    if (r.archived_at && !includeArchived)
      throw new AppError(
        409,
        "This chapter is archived. Return it to the book before changing it.",
      );
    return chapter(r);
  }
  history(id: string): ChapterRevision[] {
    this.chapter(id, true);
    return (
      this.db
        .prepare(
          `SELECT h.*, a.approved_at, a.origin approval_origin FROM chapter_revisions h
      LEFT JOIN chapter_approvals a ON a.chapter_id=h.chapter_id AND a.revision=h.revision
      WHERE h.chapter_id=? ORDER BY h.revision DESC`,
        )
        .all(id) as Row[]
    ).map((r) => ({
      chapterId: r.chapter_id,
      projectId: r.project_id,
      revision: r.revision,
      title: r.title,
      content: JSON.parse(r.content),
      status: r.status,
      parentId: r.parent_id,
      createdAt: r.created_at,
      origin: r.origin,
      proposalId: r.proposal_id,
      restoredFrom: r.restored_from,
      approvedAt: r.approved_at ?? null,
      approvalOrigin: r.approval_origin ?? null,
    }));
  }
  private snapshot(
    c: Chapter,
    origin: ChapterRevision["origin"],
    proposalId: string | null = null,
    restoredFrom: number | null = null,
  ) {
    this.db
      .prepare(
        `INSERT INTO chapter_revisions (chapter_id,revision,project_id,title,content,status,parent_id,created_at,origin,proposal_id,restored_from)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id,
        c.revision,
        c.projectId,
        c.title,
        JSON.stringify(c.content),
        c.status,
        c.parentId,
        c.updatedAt,
        origin,
        proposalId,
        restoredFrom,
      );
  }
  private approveSnapshot(
    c: Chapter,
    origin: "manual" | "proposal",
    proposalId: string | null = null,
  ) {
    this.db
      .prepare("INSERT INTO chapter_approvals VALUES (?,?,?,?,?)")
      .run(c.id, c.revision, now(), origin, proposalId);
    this.db
      .prepare("UPDATE chapters SET approved_revision=? WHERE id=?")
      .run(c.revision, c.id);
  }
  approvedChapter(id: string): Chapter | null {
    const c = this.chapter(id);
    if (c.approvedRevision === null) return null;
    const saved = this.history(id).find(
      (h) => h.revision === c.approvedRevision,
    )!;
    return {
      ...c,
      title: saved.title,
      content: saved.content,
      revision: saved.revision,
      status: "Approved",
      changedSinceApproval: false,
    };
  }
  createChapter(
    projectId: string,
    title: string,
    content: Doc = textDoc(""),
    status: Maturity = "Exploring",
    parentId: string | null = null,
    proposalId: string | null = null,
  ) {
    return this.transaction(() => {
      docSchema.parse(content);
      this.project(projectId);
      if (parentId && this.chapter(parentId).projectId !== projectId)
        throw new AppError(400, "Parent chapter belongs to another project");
      const id = randomUUID();
      const pos = (
        this.db
          .prepare(
            "SELECT coalesce(max(position), -1)+1 n FROM chapters WHERE project_id=?",
          )
          .get(projectId) as Row
      ).n;
      this.db
        .prepare(
          "INSERT INTO chapters (id,project_id,title,content,status,position,revision,updated_at,parent_id) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          projectId,
          title,
          JSON.stringify(content),
          status,
          pos,
          0,
          now(),
          parentId,
        );
      this.touch(projectId);
      const saved = this.chapter(id);
      this.snapshot(saved, proposalId ? "proposal" : "create", proposalId);
      if (status === "Approved")
        this.approveSnapshot(
          saved,
          proposalId ? "proposal" : "manual",
          proposalId,
        );
      return this.chapter(id);
    });
  }
  updateChapter(
    id: string,
    input: {
      title?: string;
      content?: Doc;
      status?: Maturity;
      parentId?: string | null;
      revision: number;
    },
    source: {
      origin?: ChapterRevision["origin"];
      proposalId?: string;
      restoredFrom?: number;
      approve?: boolean;
    } = {},
  ) {
    return this.transaction(() => {
      const c = this.chapter(id);
      if (input.content) docSchema.parse(input.content);
      const materialChange = !sameChapterContent(c, {
        title: input.title ?? c.title,
        content: input.content ?? c.content,
      });
      const explicitApproval =
        source.approve ||
        (input.status === "Approved" && c.status !== "Approved");
      const status = explicitApproval
        ? "Approved"
        : materialChange &&
            c.status === "Approved" &&
            (!input.status || input.status === "Approved")
          ? "Needs Revision"
          : (input.status ?? c.status);
      const parentId =
        input.parentId === undefined ? c.parentId : input.parentId;
      if (parentId) {
        if (this.chapter(parentId).projectId !== c.projectId)
          throw new AppError(400, "Parent chapter belongs to another project");
        if (
          parentId === id ||
          isDescendant(this.chapters(c.projectId), parentId, id)
        )
          throw new AppError(
            400,
            "A chapter cannot be placed inside itself or its descendants",
          );
      }
      const result = this.db
        .prepare(
          "UPDATE chapters SET title=?, content=?, status=?, revision=revision+1, updated_at=?, parent_id=? WHERE id=? AND revision=?",
        )
        .run(
          input.title ?? c.title,
          JSON.stringify(input.content ?? c.content),
          status,
          now(),
          parentId,
          id,
          input.revision,
        );
      if (!result.changes)
        throw new AppError(
          409,
          "This chapter changed elsewhere. Reopen it before saving your changes.",
        );
      this.touch(c.projectId);
      const saved = this.chapter(id);
      this.snapshot(
        saved,
        source.origin ?? "manual",
        source.proposalId ?? null,
        source.restoredFrom ?? null,
      );
      if (explicitApproval)
        this.approveSnapshot(
          saved,
          source.proposalId ? "proposal" : "manual",
          source.proposalId ?? null,
        );
      return this.chapter(id);
    });
  }
  approveChapter(id: string, revision: number) {
    return this.updateChapter(
      id,
      { revision, status: "Approved" },
      { approve: true },
    );
  }
  restoreChapter(id: string, savedRevision: number, revision: number) {
    const c = this.chapter(id);
    const saved = this.history(id).find((h) => h.revision === savedRevision);
    if (!saved)
      throw new AppError(404, "Saved revision not found in this chapter");
    return this.updateChapter(
      id,
      {
        title: saved.title,
        content: saved.content,
        status: c.approvedRevision === null ? "Exploring" : "Needs Revision",
        revision,
      },
      { origin: "restore", restoredFrom: savedRevision },
    );
  }
  deleteChapter(id: string) {
    const c = this.chapter(id);
    return this.archiveChapter(id, c.revision);
  }
  archiveChapter(id: string, revision: number) {
    return this.transaction(() => {
      const c = this.chapter(id);
      if (c.revision !== revision)
        throw new AppError(
          409,
          "This chapter changed elsewhere. Reopen it before archiving.",
        );
      // Move live children up without deleting source chapters or conversations.
      for (const child of this.chapters(c.projectId).filter(
        (item) => item.parentId === id,
      ))
        this.updateChapter(
          child.id,
          { parentId: c.parentId, revision: child.revision },
          { origin: "reparent" },
        );
      this.db
        .prepare(
          "UPDATE chapters SET archived_at=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?",
        )
        .run(now(), now(), id, revision);
      this.snapshot(this.chapter(id, true), "archive");
      this.chapters(c.projectId).forEach((remaining, position) =>
        this.db
          .prepare("UPDATE chapters SET position=? WHERE id=?")
          .run(position, remaining.id),
      );
      this.touch(c.projectId);
      return this.chapter(id, true);
    });
  }
  unarchiveChapter(id: string, revision: number) {
    return this.transaction(() => {
      const c = this.chapter(id, true);
      if (!c.archivedAt || c.revision !== revision)
        throw new AppError(
          409,
          "This archived chapter changed. Reload it before returning it to the book.",
        );
      const parentId =
        c.parentId && !this.chapter(c.parentId, true).archivedAt
          ? c.parentId
          : null;
      const position = this.chapters(c.projectId).length;
      this.db
        .prepare(
          "UPDATE chapters SET archived_at=NULL, parent_id=?, position=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?",
        )
        .run(parentId, position, now(), id, revision);
      this.snapshot(this.chapter(id), "unarchive");
      this.touch(c.projectId);
      return this.chapter(id);
    });
  }
  reorder(projectId: string, ids: string[]) {
    const all = this.chapters(projectId);
    if (
      new Set(ids).size !== all.length ||
      ids.length !== all.length ||
      ids.some((id) => !all.some((c) => c.id === id))
    )
      throw new AppError(400, "Supply each project chapter exactly once.");
    this.transaction(() => {
      ids.forEach((id, i) =>
        this.db.prepare("UPDATE chapters SET position=? WHERE id=?").run(i, id),
      );
      this.touch(projectId);
    });
    return this.chapters(projectId);
  }
  workshop(chapterId: string): Workshop {
    const c = this.chapter(chapterId, true);
    this.db
      .prepare("INSERT OR IGNORE INTO conversations VALUES (?,?,?)")
      .run(randomUUID(), c.projectId, chapterId);
    const id = (
      this.db
        .prepare("SELECT id FROM conversations WHERE chapter_id=?")
        .get(chapterId) as Row
    ).id;
    return {
      conversationId: id,
      messages: (
        this.db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid",
          )
          .all(id) as Row[]
      ).map(message),
      records: this.records(c.projectId).filter((r) =>
        r.relatedChapterIds.includes(chapterId),
      ),
      proposals: (
        this.db
          .prepare(
            "SELECT * FROM proposals WHERE conversation_id=? ORDER BY rowid",
          )
          .all(id) as Row[]
      ).map(proposal),
    };
  }
  addMessage(
    conversationId: string,
    role: Message["role"],
    content: string,
    state: Message["state"] = "complete",
  ) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)")
      .run(id, conversationId, role, content, state, now());
    return message(
      this.db.prepare("SELECT * FROM messages WHERE id=?").get(id)!,
    );
  }
  addProposal(
    conversationId: string,
    messageId: string,
    projectId: string,
    input: Answer["proposals"][number],
    baseRevision: number | null,
    snapshot?: Chapter,
  ) {
    const change = changeSchema.parse(input);
    const conversation = this.db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(conversationId) as Row | undefined;
    const source = this.db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(messageId) as Row | undefined;
    if (
      !conversation ||
      conversation.project_id !== projectId ||
      !source ||
      source.conversation_id !== conversationId ||
      source.role !== "assistant" ||
      source.state !== "complete"
    )
      throw new AppError(
        400,
        "Proposal source belongs to another conversation or project",
      );
    this.chapter(conversation.chapter_id);
    const kind =
      change.kind ?? (change.chapterId ? "update_chapter" : "create_chapter");
    const target = change.chapterId ? this.chapter(change.chapterId) : null;
    if (
      target &&
      (target.projectId !== projectId || target.id !== conversation.chapter_id)
    )
      throw new AppError(
        400,
        "Proposal is outside the active chapter or project",
      );
    const creation = kind === "create_chapter" || kind === "create_subchapter";
    if (creation !== (target === null))
      throw new AppError(400, "Invalid proposal target");
    const parentId = change.parentId ?? null;
    if (kind === "create_subchapter") {
      if (
        !parentId ||
        parentId !== conversation.chapter_id ||
        this.chapter(parentId).projectId !== projectId
      )
        throw new AppError(
          400,
          "A sub-chapter must belong to the active chapter in this project",
        );
    } else if (parentId)
      throw new AppError(400, "Only sub-chapter creation may specify a parent");
    const related = change.relatedChapterIds?.length
      ? change.relatedChapterIds
      : target
        ? [target.id]
        : [];
    if (related.some((id) => this.chapter(id).projectId !== projectId))
      throw new AppError(400, "Related chapter belongs to another project");
    const before = snapshot ?? target;
    if (
      target &&
      (!before ||
        before.id !== target.id ||
        before.projectId !== projectId ||
        before.revision !== baseRevision)
    )
      throw new AppError(400, "Invalid proposal revision snapshot");
    if (kind === "change_status" && !change.proposedStatus)
      throw new AppError(400, "A status proposal requires a maturity");
    if (kind !== "change_status" && change.proposedStatus)
      throw new AppError(400, "Only status proposals may change maturity");
    if (kind !== "change_status" && !change.content.trim())
      throw new AppError(400, "A proposal requires content");
    let content = designTextDoc(change.content);
    if (kind === "add_section" || kind === "revise_section") {
      if (!change.section)
        throw new AppError(400, "A section proposal requires a heading");
      const nodes = before!.content.content ?? [];
      const matches = nodes
        .map((n, i) =>
          n.type === "heading" &&
          docText({ type: "doc", content: [n] }) === change.section
            ? i
            : -1,
        )
        .filter((i) => i >= 0);
      if (kind === "add_section" && matches.length)
        throw new AppError(400, "That section already exists");
      if (kind === "revise_section" && matches.length !== 1)
        throw new AppError(400, "Section must match one existing heading");
      const heading = {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: change.section }],
      };
      if (kind === "add_section")
        content = {
          type: "doc",
          content: [...nodes, heading, ...(content.content ?? [])],
        };
      else {
        const start = matches[0],
          level = Number((nodes[start].attrs as { level: number }).level);
        let end = start + 1;
        while (
          end < nodes.length &&
          !(
            nodes[end].type === "heading" &&
            Number((nodes[end].attrs as { level: number }).level) <= level
          )
        )
          end++;
        content = {
          type: "doc",
          content: [
            ...nodes.slice(0, start + 1),
            ...(content.content ?? []),
            ...nodes.slice(end),
          ],
        };
      }
    }
    docSchema.parse(content);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO proposals (id,conversation_id,message_id,project_id,chapter_id,title,content,reason,base_revision,status,created_at,kind,description,section,proposed_status,related_chapter_ids,before_snapshot,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        conversationId,
        messageId,
        projectId,
        change.chapterId,
        change.title,
        JSON.stringify(content),
        change.reason,
        baseRevision,
        "pending",
        now(),
        kind,
        change.description || change.reason,
        change.section ?? null,
        change.proposedStatus ?? null,
        JSON.stringify(related),
        before
          ? JSON.stringify({
              title: before.title,
              content: before.content,
              status: before.status,
            })
          : null,
        parentId,
      );
    return proposal(
      this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id)!,
    );
  }
  records(projectId: string): DesignRecord[] {
    return this.knowledge.records(projectId);
  }
  resolveQuestion(
    projectId: string,
    id: string,
    input: { revision: number; answer: string },
  ) {
    this.knowledge.resolveQuestion(projectId, id, input);
    return this.records(projectId);
  }
  reviewProposal(
    id: string,
    decision: "accept" | "reject",
    placement?: { parentId: string | null },
  ) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
      if (!row) throw new AppError(404, "Proposal not found");
      const p = proposal(row);
      if (p.status !== "pending")
        throw new AppError(409, "This proposal has already been reviewed.");
      if (
        placement &&
        p.kind !== "create_chapter" &&
        p.kind !== "create_subchapter"
      )
        throw new AppError(
          400,
          "Only new chapter proposals can choose a destination",
        );
      const parentId = placement ? placement.parentId : p.parentId;
      if (
        decision === "accept" &&
        parentId &&
        this.chapter(parentId).projectId !== p.projectId
      )
        throw new AppError(400, "Parent chapter belongs to another project");
      if (decision === "accept") {
        const conversation = this.db
          .prepare("SELECT chapter_id FROM conversations WHERE id=?")
          .get(p.conversationId)!;
        this.chapter(String(conversation.chapter_id));
        const target = p.chapterId ? this.chapter(p.chapterId) : null;
        if (target && target.projectId !== p.projectId)
          throw new AppError(400, "Proposal belongs to another project");
        if (target && target.revision !== p.baseRevision)
          throw new AppError(
            409,
            "This chapter changed elsewhere. Regenerate this proposal and review the new changes.",
          );
        if (
          p.relatedChapterIds.some(
            (id) => this.chapter(id).projectId !== p.projectId,
          )
        )
          throw new AppError(400, "Invalid related chapter");
        if (p.kind === "record_decision" || p.kind === "record_question") {
          // The same transaction commits acceptance, record and verified provenance.
          this.db
            .prepare("UPDATE proposals SET status='accepted' WHERE id=?")
            .run(p.id);
          this.knowledge.createRecordFromProposal(p.id);
        } else if (target) {
          this.updateChapter(
            target.id,
            p.kind === "change_status"
              ? { revision: p.baseRevision!, status: p.proposedStatus! }
              : {
                  title: p.kind === "update_chapter" ? p.title : target.title,
                  content: p.content,
                  revision: p.baseRevision!,
                  status: "Proposed",
                },
            {
              origin: "proposal",
              proposalId: p.id,
              approve:
                p.kind === "change_status" && p.proposedStatus === "Approved",
            },
          );
        } else
          this.createChapter(
            p.projectId,
            p.title,
            p.content,
            "Proposed",
            parentId,
            p.id,
          );
      }
      this.db
        .prepare("UPDATE proposals SET status=?, parent_id=? WHERE id=?")
        .run(
          decision === "accept" ? "accepted" : "rejected",
          decision === "accept" ? parentId : p.parentId,
          id,
        );
      return proposal(
        this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id)!,
      );
    });
  }
}
