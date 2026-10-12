import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { openDatabase } from "../server/db.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { textDoc } from "../shared/types.js";
import type { Root } from "react-dom/client";
import { answerSchema, type DesignAssistant } from "../server/ai.js";
import type { KnowledgePayload } from "../shared/knowledge-proposals.js";

async function uiFixture(fullApp = false, assistant?: DesignAssistant) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  const keys: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    DOMParser: dom.window.DOMParser,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (fn: FrameRequestCallback) =>
      setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(keys).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(keys))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const rectangle = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    top: 0,
    left: 0,
    right: 1,
    bottom: 1,
    toJSON: () => ({}),
  };
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle;
  dom.window.Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as DOMRectList;
  const db = openDatabase(":memory:"),
    store = new Store(db),
    project = store.createProject("UI fixture", "Original chapter prose"),
    chapter = store.chapters(project.id)[0];
  const app = createApp(store, {
    aiConfigured: Boolean(assistant),
    ...(assistant ? { assistant } : {}),
  });
  await app.ready();
  const originalFetch = globalThis.fetch;
  const state = {
    failRefresh: false,
    delayProject: "",
    release: undefined as (() => void) | undefined,
    navigated: "",
  };
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (
      state.delayProject &&
      url.includes(`/projects/${state.delayProject}/knowledge?`)
    )
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    if (state.failRefresh && url.includes("/knowledge?"))
      return new Response(JSON.stringify({ error: "Refresh unavailable" }), {
        status: 503,
      });
    const response = await app.inject({
      method: (init?.method ?? "GET") as any,
      url,
      payload: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: {
        "Content-Type": String(
          response.headers["content-type"] ?? "application/json",
        ),
      },
    });
  };
  const { createRoot } = await import("react-dom/client"),
    { useDesignKnowledge } = await import("../client/knowledge.js"),
    { KnowledgeWorkspace } =
      await import("../client/components/knowledge/KnowledgeWorkspace.js");
  function Harness({ projectId }: { projectId: string }) {
    const controller = useDesignKnowledge(projectId),
      [selected, setSelected] = useState<string>(),
      [tab, setTab] = useState<"concepts" | "decisions" | "questions">(
        "concepts",
      );
    return createElement(KnowledgeWorkspace, {
      controller,
      selectedId: selected,
      tab,
      onTab: setTab,
      onSelectConcept: (id) => {
        setSelected(id);
        setTab("concepts");
      },
      onNavigateChapter: (id) => {
        state.navigated = id;
      },
    });
  }
  const root: Root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (projectId = project.id) => {
    await act(async () => {
      root.render(
        fullApp
          ? createElement((await import("../client/App.js")).App)
          : createElement(Harness, { projectId }),
      );
    });
  };
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await flush();
    }
    throw new Error(
      "UI condition was not reached: " +
        dom.window.document.body.textContent?.slice(-2500),
    );
  };
  const scope = () =>
    Array.from(dom.window.document.querySelectorAll("dialog[open]")).at(-1) ??
    dom.window.document.body;
  const click = async (label: string | RegExp) => {
    const element = Array.from(
      scope().querySelectorAll<HTMLButtonElement>("button,summary"),
    ).find((e) =>
      typeof label === "string"
        ? e.getAttribute("aria-label") === label ||
          e.textContent?.trim() === label
        : label.test(e.textContent ?? ""),
    );
    assert.ok(
      element,
      `Missing control ${String(label)}: ${scope().textContent}`,
    );
    await act(async () => {
      element.click();
    });
    await flush();
  };
  const fill = async (label: string, value: string) => {
    const element = scope().querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(`[aria-label="${label}"]`);
    assert.ok(element, `Missing field ${label}`);
    const prototype =
      element.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const select = async (label: string, value: string) => {
    const element = scope().querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    );
    assert.ok(element, `Missing selector ${label}`);
    await act(async () => {
      element.value = value;
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  const check = async (label: string) => {
    const row = Array.from(scope().querySelectorAll("label")).find(
        (e) => e.textContent?.trim() === label,
      ),
      input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(input, `Missing checkbox ${label}`);
    await act(async () => {
      input.click();
    });
  };
  const text = () => dom.window.document.body.textContent ?? "";
  await render();
  await wait(() =>
    fullApp
      ? text().includes("Your projects")
      : text().includes("Your design, connected"),
  );
  return {
    dom,
    store,
    db,
    project,
    chapter,
    app,
    state,
    root,
    render,
    wait,
    click,
    fill,
    select,
    check,
    text,
    flush,
    scope,
    close: async () => {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await app.close();
      db.close();
      dom.window.close();
      globalThis.fetch = originalFetch;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
      }
    },
  };
}

test("frontend concepts can be created, filtered, edited, explicitly approved, archived and restored with readable history", async () => {
  const f = await uiFixture();
  try {
    await f.click("New concept");
    await f.fill("Concept name", "Inventory");
    await f.fill("Concept category", "system");
    await f.fill("Concept description", "Keep materials for extraction.");
    await f.click("Create exploring concept");
    await f.wait(() => f.text().includes("Keep materials for extraction."));
    let c = f.store.knowledge.concepts(f.project.id)[0];
    assert.equal(c.authoritative, false);
    await f.click("Approve concept");
    await f.click("Approve concept");
    await f.wait(() => f.text().includes("Reviewed knowledge"));
    c = f.store.knowledge.concept(f.project.id, c.id);
    assert.equal(c.authoritative, true);
    await f.fill("Search concepts", "missing");
    assert.ok(f.text().includes("No matching concepts"));
    await f.fill("Search concepts", "inventory");
    assert.ok(
      f.dom.window.document.querySelector(
        '[aria-label="Open concept Inventory"]',
      ),
    );
    await f.select("Filter concept category", "system");
    await f.select("Filter concept maturity", "Approved");
    assert.ok(
      f.dom.window.document.querySelector(
        '[aria-label="Open concept Inventory"]',
      ),
    );
    await f.select("Filter concept maturity", "");
    await f.click("Edit concept");
    await f.fill("Concept description", "An updated capacity rule.");
    await f.click("Save concept");
    await f.wait(() => f.text().includes("Current changes are unreviewed"));
    assert.equal(
      f.store.knowledge.concept(f.project.id, c.id).status,
      "Needs Revision",
    );
    await f.click("Inspect approved version");
    await f.wait(() => f.text().includes("Historical snapshot"));
    assert.ok(f.text().includes("Keep materials for extraction."));
    await f.click("Close knowledge history");
    await f.click("Archive concept");
    await f.click("Archive concept");
    await f.wait(() =>
      Boolean(f.store.knowledge.concept(f.project.id, c.id).archivedAt),
    );
    await f.click("Return concept");
    await f.click("Return concept");
    await f.wait(
      () => f.store.knowledge.concept(f.project.id, c.id).archivedAt === null,
    );
    assert.equal(
      f.store.knowledge.concept(f.project.id, c.id).authoritative,
      false,
    );
    assert.equal(f.store.chapter(f.chapter.id).revision, 0);
  } finally {
    await f.close();
  }
});
test("frontend relationships distinguish direction, navigate concepts, reject duplicates and preserve retired history", async () => {
  const f = await uiFixture();
  try {
    const a = f.store.knowledge.createConcept(f.project.id, {
        name: "Inventory",
      }),
      b = f.store.knowledge.createConcept(f.project.id, { name: "Extraction" });
    await f.render();
    // Trigger an explicit refresh through a project remount to load fixture subjects.
    await act(async () => f.root.render(null));
    await f.render();
    await f.wait(() =>
      Boolean(
        f.dom.window.document.querySelector(
          '[aria-label="Open concept Inventory"]',
        ),
      ),
    );
    await f.click("Open concept Inventory");
    await f.click("Connect concept");
    await f.select("To concept", b.id);
    await f.select("Relationship type", "depends_on");
    await f.fill(
      "Relationship rationale",
      "Capacity changes extraction difficulty.",
    );
    await f.click("Create exploratory relationship");
    await f.wait(() => f.text().includes("Outgoing · directional"));
    let r = f.store.knowledge.relationships(f.project.id)[0];
    assert.equal(r.authoritative, false);
    await f.click("Approve relationship");
    await f.click("Approve relationship");
    await f.wait(
      () => f.store.knowledge.relationship(f.project.id, r.id).authoritative,
    );
    await f.click("Extraction");
    assert.ok(f.text().includes("Incoming · directional"));
    await f.click("Connect concept");
    await f.select("From concept", a.id);
    await f.select("To concept", b.id);
    await f.click("Create exploratory relationship");
    await f.wait(() => f.text().includes("already exists"));
    assert.equal(f.store.knowledge.relationships(f.project.id).length, 1);
    await f.click("Cancel");
    await f.click("Retire relationship");
    await f.click("Retire relationship");
    await f.wait(() =>
      Boolean(f.store.knowledge.relationship(f.project.id, r.id).retiredAt),
    );
    await f.check("Include retired relationships and superseded decisions");
    assert.ok(f.text().includes("Retired"));
    await f.click("History & sources");
    await f.wait(() => f.text().includes("Historical snapshot"));
    assert.ok(f.text().includes("Capacity changes extraction difficulty."));
    await f.click("Close knowledge history");
  } finally {
    await f.close();
  }
});
test("frontend decisions supersede explicitly and questions retain answers through resolution and reopening", async () => {
  const f = await uiFixture();
  try {
    await f.click(/^Decisions/);
    await f.click("New decision");
    await f.fill("Decision statement", "Cooperative extraction");
    await f.fill("Knowledge rationale", "Shared goals.");
    await f.click("Create approved decision");
    await f.wait(() => f.text().includes("Approved decision"));
    const original = f.store.records(f.project.id)[0];
    await f.click("Supersede decision");
    await f.fill("Decision statement", "Solo extraction");
    await f.fill("Knowledge rationale", "A focused experience.");
    await f.click("Approve replacement decision");
    await f.wait(() => f.text().includes("Solo extraction"));
    await f.check("Include superseded decisions");
    assert.ok(f.text().includes("Historical · Superseded"));
    assert.equal(
      f.store.knowledge.record(f.project.id, original.id).text,
      "Cooperative extraction",
    );
    await f.click(/^Questions/);
    await f.click("New question");
    await f.fill("Question", "What determines capacity?");
    await f.fill("Knowledge rationale", "It affects difficulty.");
    await f.click("Create open question");
    await f.wait(() => f.text().includes("Open question"));
    const question = f.store
      .records(f.project.id)
      .find((r) => r.kind === "question")!;
    await f.click("Resolve question");
    await f.fill("Resolution answer", "Backpack upgrades.");
    await f.click("Save answer");
    await f.wait(() => f.text().includes("Recorded answer"));
    assert.ok(f.text().includes("Backpack upgrades."));
    await f.click("Reopen question");
    await f.click("Reopen question");
    await f.wait(
      () =>
        f.store.knowledge.record(f.project.id, question.id).status === "open",
    );
    await f.click("History");
    await f.wait(() => f.text().includes("Historical snapshot"));
    await f.select("Knowledge version", "1");
    assert.ok(f.text().includes("Backpack upgrades."));
    await f.click("Close knowledge history");
  } finally {
    await f.close();
  }
});
test("frontend conflict handling preserves drafts and saved mutations are not retried when refresh fails", async () => {
  const f = await uiFixture();
  try {
    await f.click("New concept");
    await f.fill("Concept name", "Inventory");
    await f.click("Create exploring concept");
    await f.wait(() => f.text().includes("Edit concept"));
    let c = f.store.knowledge.concepts(f.project.id)[0];
    await f.click("Edit concept");
    await f.fill("Concept description", "My unsaved draft");
    f.store.knowledge.updateConcept(f.project.id, c.id, {
      revision: c.revision,
      description: "Another window's saved change",
    });
    await f.click("Save concept");
    await f.wait(() => f.text().includes("changed elsewhere"));
    assert.equal(
      f
        .scope()
        .querySelector<HTMLTextAreaElement>(
          '[aria-label="Concept description"]',
        )!.value,
      "My unsaved draft",
    );
    assert.equal(
      f.store.knowledge.concept(f.project.id, c.id).description,
      "Another window's saved change",
    );
    await f.click("Discard draft and reload");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    assert.ok(f.text().includes("Another window's saved change"));
    await f.click("Edit concept");
    await f.fill("Concept description", "Committed change");
    f.state.failRefresh = true;
    await f.click("Save concept");
    await f.wait(() => f.text().includes("Your change was saved"));
    assert.equal(
      f.store.knowledge.concept(f.project.id, c.id).description,
      "Committed change",
    );
    assert.equal(
      f.store.knowledge.history(f.project.id, "concept", c.id).length,
      3,
    );
    f.state.failRefresh = false;
    await f.click("Reload Design Knowledge");
    await f.wait(() => f.text().includes("Committed change"));
  } finally {
    await f.close();
  }
});
test("frontend project switching ignores late data and source inspection preserves exact historical chapter content", async () => {
  const f = await uiFixture();
  try {
    const sourced = f.store.knowledge.createConcept(f.project.id, {
      name: "Private subject",
      source: { kind: "chapter", chapterId: f.chapter.id, revision: 0 },
    });
    await act(async () => f.root.render(null));
    await f.render();
    await f.wait(() =>
      Boolean(
        f.dom.window.document.querySelector(
          '[aria-label="Open concept Private subject"]',
        ),
      ),
    );
    f.store.updateChapter(f.chapter.id, {
      revision: 0,
      content: textDoc("A newer chapter"),
    });
    await f.click("Open concept Private subject");
    const evidence = f.dom.window.document.querySelector(
      ".knowledge-evidence summary",
    ) as HTMLElement;
    await act(async () => evidence.click());
    await f.click("Inspect source");
    await f.wait(() => f.text().includes("Saved chapter version 0"));
    assert.ok(f.text().includes("Original chapter prose"));
    assert.ok(f.scope().textContent?.includes("Historical source"));
    assert.ok(!f.scope().textContent?.includes("A newer chapter"));
    await f.click("Close source");
    const other = f.store.createProject("Other", "");
    f.store.knowledge.createConcept(other.id, { name: "Other subject" });
    f.state.delayProject = f.project.id;
    await act(async () => f.root.render(null));
    await f.render();
    await f.wait(() => typeof f.state.release === "function");
    await f.render(other.id);
    await f.wait(() =>
      Boolean(
        f.dom.window.document.querySelector(
          '[aria-label="Open concept Other subject"]',
        ),
      ),
    );
    f.state.delayProject = "";
    f.state.release?.();
    await f.flush();
    assert.ok(
      !f.dom.window.document.querySelector(
        '[aria-label="Open concept Private subject"]',
      ),
    );
    const blocked = await f.app.inject(
      `/api/projects/${other.id}/knowledge/sources/${sourced.sources[0].id}`,
    );
    assert.equal(blocked.statusCode, 404);
  } finally {
    await f.close();
  }
});
test("application navigation links a concept to a chapter, opens chapter context and disassociates without changing prose", async () => {
  const f = await uiFixture(true);
  try {
    await f.click(/^UUI fixture$/);
    await f.wait(
      () =>
        f.text().includes("Chapter title") ||
        Boolean(
          f.dom.window.document.querySelector('[aria-label="Chapter title"]'),
        ),
    );
    await f.click("Design Knowledge");
    await f.wait(() => f.text().includes("Your design, connected"));
    await f.click("New concept");
    await f.fill("Concept name", "Movement");
    await f.click("Create exploring concept");
    await f.wait(() => f.text().includes("Edit chapter links"));
    await f.click("Edit chapter links");
    await f.check("Game Vision");
    await f.click("Save chapter links");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    await f.click("Game Vision");
    await f.wait(() =>
      Boolean(
        f.dom.window.document.querySelector('[aria-label="Chapter title"]'),
      ),
    );
    const summary = f.dom.window.document.querySelector(
      ".chapter-knowledge > summary",
    ) as HTMLElement;
    await act(async () => summary.click());
    assert.ok(f.text().includes("Movement · Exploring"));
    await f.click("Movement · Exploring");
    await f.wait(() => f.text().includes("Edit concept"));
    await f.click("Game Vision");
    await f.wait(() =>
      Boolean(
        f.dom.window.document.querySelector('[aria-label="Chapter title"]'),
      ),
    );
    await act(async () => {
      (
        f.dom.window.document.querySelector(
          ".chapter-knowledge > summary",
        ) as HTMLElement
      ).click();
    });
    await f.click("Disassociate Movement from chapter");
    await f.click("Remove chapter association");
    await f.wait(
      () => f.store.knowledge.concepts(f.project.id)[0].chapterIds.length === 0,
    );
    assert.equal(f.store.chapter(f.chapter.id).revision, 0);
    assert.deepEqual(f.store.chapter(f.chapter.id).content, f.chapter.content);
  } finally {
    await f.close();
  }
});

test("Workshop extraction reviews dependent knowledge individually with authority choices and accepted-result navigation", async () => {
  const assistant: DesignAssistant = async (ctx) => {
    assert.equal(ctx.workflow, "extract");
    const payloads: KnowledgePayload[] = [
      {
        version: 1,
        action: "create_concept",
        key: "inventory",
        name: "Inventory",
        category: "system",
        description: "Carry meaningful discoveries",
        chapterIds: [ctx.active.id],
      },
      {
        version: 1,
        action: "create_concept",
        key: "extraction",
        name: "Extraction",
        category: "mechanic",
        description: "Return with discoveries",
        chapterIds: [ctx.active.id],
      },
      {
        version: 1,
        action: "create_relationship",
        source: { newConcept: "inventory" },
        target: { newConcept: "extraction" },
        type: "affects",
        rationale: "Capacity shapes return timing",
      },
      {
        version: 1,
        action: "record_decision",
        text: "Carrying space is limited",
        rationale: "Deliberate choices",
        chapterIds: [ctx.active.id],
        concepts: [{ newConcept: "inventory" }],
      },
      {
        version: 1,
        action: "record_question",
        text: "How much space?",
        rationale: "Pacing",
        chapterIds: [ctx.active.id],
        concepts: [{ newConcept: "inventory" }],
      },
    ];
    return answerSchema.parse({
      reply: "These subjects are worth reviewing.",
      proposals: payloads.map((knowledge, i) => ({
        kind: "knowledge",
        title: [
          "Inventory concept",
          "Extraction concept",
          "Capacity connection",
          "Limited capacity decision",
          "Capacity question",
        ][i],
        reason: "Useful design knowledge",
        description: "Review a meaningful subject",
        knowledge,
      })),
    });
  };
  const f = await uiFixture(true, assistant);
  try {
    await f.click(/^UUI fixture$/);
    await f.wait(() => f.text().includes("AI Workshop"));
    await f.click("Design together");
    await f.click("Extract Design Knowledge");
    await f.wait(() => f.text().includes("Capacity connection"));
    assert.equal(f.store.knowledge.concepts(f.project.id).length, 0);
    await f.click(/PROPOSED CREATE RELATIONSHIPCapacity connection/);
    await f.wait(
      () => f.scope().textContent?.includes("Accept prerequisite") === true,
    );
    assert.ok(f.scope().textContent?.includes("Inventory affects Extraction"));
    assert.equal(
      Array.from(f.scope().querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === "Approve knowledge",
      )!.disabled,
      true,
    );
    await f.click("Close dialog");
    await f.click(/PROPOSED CREATE CONCEPTInventory concept/);
    await f.wait(() => !f.scope().textContent?.includes("Checking current"));
    await f.click("Accept as Exploring");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    assert.equal(
      f.store.knowledge.concepts(f.project.id)[0].status,
      "Exploring",
    );
    await f.click(/PROPOSED CREATE CONCEPTExtraction concept/);
    await f.wait(() => !f.scope().textContent?.includes("Checking current"));
    await f.click("Approve knowledge");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    await f.click(/PROPOSED CREATE RELATIONSHIPCapacity connection/);
    await f.wait(() => !f.scope().textContent?.includes("Checking current"));
    assert.ok(f.scope().textContent?.includes("accepted as Exploring"));
    await f.click("Approve knowledge");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    assert.equal(
      f.store.knowledge.relationships(f.project.id)[0].authoritative,
      true,
    );
    await f.click(/PROPOSED RECORD DECISIONLimited capacity decision/);
    await f.wait(() => !f.scope().textContent?.includes("Checking current"));
    assert.ok(f.scope().textContent?.includes("binding design decision"));
    await f.click("Approve decision");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    await f.click(/PROPOSED RECORD QUESTIONCapacity question/);
    await f.wait(() => !f.scope().textContent?.includes("Checking current"));
    await f.click("Reject knowledge proposal");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    assert.equal(f.store.knowledge.records(f.project.id).length, 1);
    await f.click("Open in Design Knowledge");
    await f.wait(() => f.text().includes("Edit concept"));
    assert.ok(f.text().includes("Inventory"));
    assert.ok(f.text().includes("Carrying space is limited"));
    assert.equal(f.store.chapter(f.chapter.id).revision, 0);
  } finally {
    await f.close();
  }
});

test("knowledge proposal preview preserves original content and blocks stale approval while permitting rejection", async () => {
  const f = await uiFixture(true, async () => ({
    reply: "Ready",
    proposals: [],
  }));
  try {
    const c = f.store.knowledge.createConcept(f.project.id, {
      name: "Movement",
      description: "Original description",
    });
    const w = f.store.workshop(f.chapter.id),
      m = f.store.addMessage(
        w.conversationId,
        "assistant",
        "A proposed refinement",
      );
    f.store.knowledgeProposals.addBatch(
      w.conversationId,
      m.id,
      f.chapter,
      f.store.knowledge.projectKnowledge(f.project.id, true),
      [
        {
          kind: "knowledge",
          title: "Refine movement",
          reason: "Focus",
          description: "A refinement",
          knowledge: {
            version: 1,
            action: "update_concept",
            targetId: c.id,
            revision: c.revision,
            name: c.name,
            category: c.category,
            description: "Proposed description",
          },
        },
      ],
    );
    f.store.knowledge.updateConcept(f.project.id, c.id, {
      revision: c.revision,
      description: "Newer saved description",
    });
    await f.click(/^UUI fixture$/);
    await f.wait(() => f.text().includes("Refine movement"));
    await f.click(/PROPOSED UPDATE CONCEPTRefine movement/);
    await f.wait(
      () =>
        f
          .scope()
          .textContent?.includes("Knowledge or source revisions changed") ===
        true,
    );
    assert.ok(f.scope().textContent?.includes("Original description"));
    assert.ok(f.scope().textContent?.includes("Proposed description"));
    const approve = Array.from(
      f.scope().querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Approve knowledge")!;
    assert.equal(approve.disabled, true);
    await f.click("Reject knowledge proposal");
    await f.wait(() => !f.dom.window.document.querySelector("dialog[open]"));
    assert.equal(
      f.store.knowledge.concept(f.project.id, c.id).description,
      "Newer saved description",
    );
  } finally {
    await f.close();
  }
});
