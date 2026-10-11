export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Forge could not complete this request.");
  return data;
}

export async function chat(
  chapterId: string,
  content: string,
  signal: AbortSignal,
  onEvent: (event: string, data: any) => void,
  workflow?: import("../shared/types").Workflow,
) {
  const response = await fetch(`/api/chapters/${chapterId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, workflow }),
    signal,
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error);
  }
  if (!response.body)
    throw new Error("The Workshop did not return a response.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame
          .split("\n")
          .find((l) => l.startsWith("event: "))
          ?.slice(7);
        const data = frame
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6);
        if (event && data) onEvent(event, JSON.parse(data));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
