import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  textDoc,
  type Chapter,
  type Doc,
  type Maturity,
  type Message,
  type Project,
  type Proposal,
  type Workshop,
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
  title: r.title,
  content: JSON.parse(r.content),
  status: r.status,
  position: r.position,
  revision: r.revision,
  updatedAt: r.updated_at,
});
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
  title: r.title,
  content: JSON.parse(r.content),
  reason: r.reason,
  baseRevision: r.base_revision,
  status: r.status,
  createdAt: r.created_at,
});

export class Store {
  constructor(public db: DatabaseSync) {}
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  projects(): Project[] {
    return (
      this.db
        .prepare(
          `SELECT p.*, (SELECT count(*) FROM chapters c WHERE c.project_id=p.id) chapter_count FROM projects p ORDER BY updated_at DESC`,
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
  chapters(id: string) {
    this.project(id);
    return (
      this.db
        .prepare(
          "SELECT * FROM chapters WHERE project_id=? ORDER BY position, id",
        )
        .all(id) as Row[]
    ).map(chapter);
  }
  chapter(id: string) {
    const r = this.db.prepare("SELECT * FROM chapters WHERE id=?").get(id);
    if (!r) throw new AppError(404, "Chapter not found");
    return chapter(r);
  }
  createChapter(
    projectId: string,
    title: string,
    content: Doc = textDoc(""),
    status: Maturity = "Exploring",
  ) {
    this.project(projectId);
    const id = randomUUID();
    const pos = (
      this.db
        .prepare(
          "SELECT coalesce(max(position), -1)+1 n FROM chapters WHERE project_id=?",
        )
        .get(projectId) as Row
    ).n;
    this.db
      .prepare("INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)")
      .run(
        id,
        projectId,
        title,
        JSON.stringify(content),
        status,
        pos,
        0,
        now(),
      );
    this.touch(projectId);
    return this.chapter(id);
  }
  updateChapter(
    id: string,
    input: {
      title?: string;
      content?: Doc;
      status?: Maturity;
      revision: number;
    },
  ) {
    const c = this.chapter(id);
    const result = this.db
      .prepare(
        "UPDATE chapters SET title=?, content=?, status=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?",
      )
      .run(
        input.title ?? c.title,
        JSON.stringify(input.content ?? c.content),
        input.status ?? c.status,
        now(),
        id,
        input.revision,
      );
    if (!result.changes)
      throw new AppError(
        409,
        "This chapter changed elsewhere. Reopen it before saving your changes.",
      );
    this.touch(c.projectId);
    return this.chapter(id);
  }
  deleteChapter(id: string) {
    const c = this.chapter(id);
    this.transaction(() => {
      this.db.prepare("DELETE FROM chapters WHERE id=?").run(id);
      this.chapters(c.projectId).forEach((remaining, position) =>
        this.db
          .prepare("UPDATE chapters SET position=? WHERE id=?")
          .run(position, remaining.id),
      );
      this.touch(c.projectId);
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
    const c = this.chapter(chapterId);
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
    change: {
      chapterId: string | null;
      title: string;
      content: string;
      reason: string;
    },
    baseRevision: number | null,
  ) {
    if (
      change.chapterId &&
      this.chapter(change.chapterId).projectId !== projectId
    )
      throw new AppError(400, "Proposal belongs to another project");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        conversationId,
        messageId,
        projectId,
        change.chapterId,
        change.title,
        JSON.stringify(textDoc(change.content)),
        change.reason,
        baseRevision,
        "pending",
        now(),
      );
    return proposal(
      this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id)!,
    );
  }
  reviewProposal(id: string, decision: "accept" | "reject") {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
      if (!row) throw new AppError(404, "Proposal not found");
      const p = proposal(row);
      if (p.status !== "pending")
        throw new AppError(409, "This proposal has already been reviewed.");
      if (decision === "accept") {
        if (p.chapterId)
          this.updateChapter(p.chapterId, {
            title: p.title,
            content: p.content,
            revision: p.baseRevision!,
            status: "Proposed",
          });
        else this.createChapter(p.projectId, p.title, p.content, "Proposed");
      }
      this.db
        .prepare("UPDATE proposals SET status=? WHERE id=?")
        .run(decision === "accept" ? "accepted" : "rejected", id);
      return proposal(
        this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id)!,
      );
    });
  }
}
