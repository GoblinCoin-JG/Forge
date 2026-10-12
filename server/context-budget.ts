import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import type { AIContext } from "./ai.js";
import type { ContextLimits, PreparedRequest } from "../shared/context.js";
import {
  providerBody,
  providerFormatVersion,
  sourceContext,
} from "./provider-format.js";

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const bytes = (value: unknown) =>
  Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
const numberSetting = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
};
export function contextLimits(
  overrides: Partial<ContextLimits> = {},
): ContextLimits {
  const model = overrides.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  // Official capacities verified October 11, 2026; retain conservative encoding
  // bounds when the configured model's tokenizer has not been established.
  const known = /^gpt-4\.1(?:-mini|-nano)?(?:-2025-04-14)?$/.test(model);
  const knownSol = model === "gpt-6.1-sol";
  const modelCapacity = known ? 1047576 : knownSol ? 1050000 : 32768;
  const modelOutputLimit = known ? 32768 : knownSol ? 128000 : undefined;
  const configuredTokenizer = process.env.FORGE_TOKENIZER;
  if (
    configuredTokenizer &&
    !["o200k_base", "cl100k_base", "byte-bound"].includes(configuredTokenizer)
  )
    throw new Error(
      "FORGE_TOKENIZER must be o200k_base, cl100k_base or byte-bound.",
    );
  const result: ContextLimits = {
    contextBytes: numberSetting("FORGE_CONTEXT_BYTES", 128 * 1024),
    requestBytes: numberSetting("FORGE_REQUEST_BYTES", 192 * 1024),
    contextTokens: numberSetting("FORGE_MODEL_CONTEXT_TOKENS", modelCapacity),
    outputTokens: numberSetting("FORGE_OUTPUT_TOKENS", 8192),
    model,
    tokenizer:
      (configuredTokenizer as ContextLimits["tokenizer"]) ??
      (known ? "o200k_base" : "byte-bound"),
    ...overrides,
  };
  if (
    ![
      result.contextBytes,
      result.requestBytes,
      result.contextTokens,
      result.outputTokens,
    ].every((v) => Number.isSafeInteger(v) && v > 0) ||
    result.outputTokens >= result.contextTokens
  )
    throw new Error(
      "Context budgets and model capacity must be positive integers with output headroom below total capacity.",
    );
  if (modelOutputLimit !== undefined && result.outputTokens > modelOutputLimit)
    throw new Error(
      `Configured output headroom exceeds this model's supported ${modelOutputLimit}-token output limit.`,
    );
  if ((known || knownSol) && result.contextTokens > modelCapacity)
    throw new Error(
      `Configured context capacity exceeds this model's verified ${modelCapacity}-token window.`,
    );
  return result;
}
const encoders = new Map<string, ReturnType<typeof getEncoding>>();
const tokenCounts = new Map<string, number>();
function hasLongText(value: unknown): boolean {
  if (typeof value === "string") return /[^\s]{4096}/u.test(value);
  if (Array.isArray(value)) return value.some(hasLongText);
  if (value && typeof value === "object")
    return Object.values(value).some(hasLongText);
  return false;
}
export function prepareProviderRequest(
  context: AIContext,
  limits = contextLimits(),
): PreparedRequest {
  const contextSerialized = JSON.stringify({
    ...sourceContext(context),
    messages: context.messages,
  });
  const serialized = JSON.stringify(providerBody(context, limits));
  const requestBytes = bytes(serialized),
    contextBytes = bytes(contextSerialized);
  const requestDigest = digest(serialized);
  // Long unbroken text can make JS BPE encoding quadratic. A byte bound is
  // conservative and predictable for such inputs, including adversarial prose.
  const useByteBound =
    limits.tokenizer === "byte-bound" ||
    hasLongText(JSON.parse(contextSerialized));
  let encoded = requestBytes;
  if (!useByteBound && limits.tokenizer !== "byte-bound") {
    if (!encoders.has(limits.tokenizer))
      encoders.set(limits.tokenizer, getEncoding(limits.tokenizer));
    const key = limits.tokenizer + requestDigest;
    if (!tokenCounts.has(key)) {
      if (tokenCounts.size >= 64)
        tokenCounts.delete(tokenCounts.keys().next().value!);
      tokenCounts.set(
        key,
        encoders.get(limits.tokenizer)!.encode(serialized, [], []).length,
      );
    }
    encoded = tokenCounts.get(key)!;
  }
  // Full JSON token count plus framing and schema-transformation safety allowance.
  const estimatedInputTokens = useByteBound
    ? encoded + 256
    : Math.ceil(encoded * 1.15) + 1024;
  return {
    serialized,
    contextSerialized,
    requestDigest,
    contextDigest: digest(contextSerialized),
    requestBytes,
    contextBytes,
    estimatedInputTokens,
    tokenMethod: useByteBound
      ? "conservative UTF-8 byte upper bound + framing"
      : `${limits.tokenizer} full-request estimate + 15% + 1024 token reserve`,
    limits,
    format: providerFormatVersion,
  };
}
export function requestFits(request: PreparedRequest) {
  return (
    request.contextBytes <= request.limits.contextBytes &&
    request.requestBytes <= request.limits.requestBytes &&
    request.estimatedInputTokens + request.limits.outputTokens <=
      request.limits.contextTokens
  );
}
export function verifyPreparedRequest(
  context: AIContext,
  request: PreparedRequest,
) {
  const rebuilt = prepareProviderRequest(context, request.limits);
  if (
    rebuilt.serialized !== request.serialized ||
    digest(request.serialized) !== request.requestDigest ||
    rebuilt.contextDigest !== request.contextDigest
  )
    throw new Error(
      "The selected context changed after the provider request was finalized. Retry the request.",
    );
  if (!requestFits(request))
    throw new Error(
      "The complete instructions and request cannot fit the configured context/model capacity with output headroom. Increase the configured budget/capacity or send a smaller request; no instructions were truncated.",
    );
}
