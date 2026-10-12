import { useCallback, useEffect, useRef, useState } from "react";
import type { Chapter } from "../shared/types";
import type { ProjectKnowledge, RelationshipType } from "../shared/knowledge";
import { api } from "./api";

export const relationshipLabels: Record<RelationshipType, string> = {
  depends_on: "depends on",
  interacts_with: "interacts with",
  affects: "affects",
  part_of: "is part of",
  conflicts_with: "conflicts with",
};
export interface KnowledgeController {
  projectId: string;
  data?: ProjectKnowledge;
  chapters: Chapter[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  read: <T>(path: string) => Promise<T>;
  mutate: <T>(path: string, method: string, body: unknown) => Promise<T>;
}
export function useDesignKnowledge(projectId?: string): KnowledgeController {
  const [state, setState] = useState<{
    projectId?: string;
    data?: ProjectKnowledge;
    chapters: Chapter[];
    loading: boolean;
    error: string;
  }>({ chapters: [], loading: false, error: "" });
  const generation = useRef(0),
    current = useRef(projectId);
  current.current = projectId;
  const reload = useCallback(async () => {
    const ticket = ++generation.current;
    if (!projectId) {
      setState({ chapters: [], loading: false, error: "" });
      return;
    }
    setState((s) =>
      s.projectId === projectId
        ? { ...s, loading: true, error: "" }
        : { projectId, chapters: [], loading: true, error: "" },
    );
    try {
      const [data, live, archived] = await Promise.all([
        api<ProjectKnowledge>(
          `/projects/${projectId}/knowledge?includeHistorical=true`,
        ),
        api<Chapter[]>(`/projects/${projectId}/chapters`),
        api<Chapter[]>(`/projects/${projectId}/archived-chapters`),
      ]);
      if (ticket === generation.current && current.current === projectId)
        setState({
          projectId,
          data,
          chapters: [...live, ...archived],
          loading: false,
          error: "",
        });
    } catch (e) {
      if (ticket === generation.current && current.current === projectId)
        setState((s) => ({
          ...s,
          loading: false,
          error: (e as Error).message,
        }));
      throw e;
    }
  }, [projectId]);
  useEffect(() => {
    void reload().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [reload]);
  const scoped =
    state.projectId === projectId
      ? state
      : {
          data: undefined,
          chapters: [],
          loading: Boolean(projectId),
          error: "",
        };
  return {
    projectId: projectId ?? "",
    data: scoped.data,
    chapters: scoped.chapters,
    loading: scoped.loading,
    error: scoped.error,
    reload,
    read: <T>(path: string) => api<T>(`/projects/${projectId}${path}`),
    mutate: async <T>(path: string, method: string, body: unknown) => {
      if (!projectId || current.current !== projectId)
        throw new Error(
          "The project changed. Reopen this action in the current project.",
        );
      const result = await api<T>(
        `/projects/${projectId}${path}`,
        method,
        body,
      );
      try {
        await reload();
      } catch (e) {
        if (current.current === projectId)
          setState((s) => ({
            ...s,
            error: `Your change was saved, but refreshing failed. ${(e as Error).message} Reload Design Knowledge.`,
          }));
      }
      return result;
    },
  };
}
export function chapterLabel(controller: KnowledgeController, id: string) {
  return (
    controller.chapters.find((c) => c.id === id)?.title ?? "Unavailable chapter"
  );
}
export function conceptLabel(controller: KnowledgeController, id: string) {
  return (
    controller.data?.concepts.find((c) => c.id === id)?.name ??
    "Unavailable concept"
  );
}
export function readableDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}
