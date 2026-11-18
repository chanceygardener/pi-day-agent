// Ollama provider for pi: discovers installed tool-capable models and persists the catalog for offline startup.

import { isModelType, type Model, type ModelsStoreEntry, type RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { OllamaClient, type OllamaModelDetails, OllamaUnavailableError } from "./client.ts";

export const OLLAMA_PROVIDER_ID = "ollama";
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/** Context assumed when Ollama reports nothing: its smallest VRAM-based default. */
const FALLBACK_CONTEXT_WINDOW = 4096;

/** Upper bound on catalog discovery, which runs at every startup, so a hung server cannot stall pi. */
const CATALOG_DEADLINE_MS = 5000;

/** Inputs that decide how much context Ollama will actually give a model. */
export interface ContextEvidence {
	details: OllamaModelDetails;
	/** Allocated context of the model if it is loaded right now (GET /api/ps). */
	loadedContextLength?: number;
	/** `OLLAMA_CONTEXT_LENGTH` as seen by this process. */
	serverContextLimit?: number;
}

/** Provider registration for `pi.registerProvider(OLLAMA_PROVIDER_ID, ...)`. */
export function createOllamaProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
	const host = resolveOllamaHost(env.OLLAMA_HOST);
	const client = new OllamaClient(host);
	const serverContextLimit = parsePositiveInteger(env.OLLAMA_CONTEXT_LENGTH);
	return {
		name: "Ollama",
		baseUrl: `${host}/v1`,
		// Ollama ignores the key; pi needs one to treat the provider as configured.
		apiKey: "ollama",
		api: "openai-completions",
		refreshModels: (context) => refreshOllamaModels(client, serverContextLimit, context),
	};
}

/**
 * Fetches and persists the live catalog. When the fetch is not allowed, times out, or finds the
 * server down, keeps the persisted catalog so models stay selectable; requests then fail with
 * Ollama's own connection error.
 */
export async function refreshOllamaModels(
	client: OllamaClient,
	serverContextLimit: number | undefined,
	context: RefreshModelsContext,
	deadlineMs = CATALOG_DEADLINE_MS,
): Promise<Model<"openai-completions">[]> {
	const stored = storedOllamaModels(context.stored, client.baseUrl);
	// Deviates from the built-in llama.cpp provider, which skips discovery whenever allowNetwork is
	// false. pi refreshes with allowNetwork false in print mode and with --offline, and pi-day's
	// offline principle forbids internet access, not loopback, so a local server stays discoverable.
	if ((!context.allowNetwork && !isLoopback(client.baseUrl)) || context.signal.aborted) return stored;
	const deadline = AbortSignal.timeout(deadlineMs);
	try {
		const signal = AbortSignal.any([context.signal, deadline]);
		const models = await fetchOllamaCatalog(client, serverContextLimit, signal);
		await context.publish({ persist: { models, checkedAt: Date.now() } });
		return models;
	} catch (error) {
		if (error instanceof OllamaUnavailableError || context.signal.aborted || deadline.aborted) return stored;
		throw error;
	}
}

/** Builds pi models for every installed Ollama model that supports tool calls. */
export async function fetchOllamaCatalog(
	client: OllamaClient,
	serverContextLimit: number | undefined,
	signal: AbortSignal,
): Promise<Model<"openai-completions">[]> {
	const [names, loaded] = await Promise.all([client.listModelNames(signal), client.loadedContextLengths(signal)]);
	const details = await Promise.all(names.map((name) => client.showModel(name, signal)));
	return names.flatMap((name, index) => {
		const evidence = { details: details[index], loadedContextLength: loaded.get(name), serverContextLimit };
		// pi drives every turn through tools; Ollama rejects tool requests for models without the capability.
		return evidence.details.capabilities.includes("tools") ? [toPiModel(name, evidence, client.baseUrl)] : [];
	});
}

/**
 * The window Ollama will allocate, most authoritative first: a loaded model's actual allocation,
 * the Modelfile's num_ctx, then the trained length capped by OLLAMA_CONTEXT_LENGTH. Ollama's
 * VRAM-based default is not observable before loading, so the last rule assumes enough memory.
 */
export function effectiveContextWindow({ details, loadedContextLength, serverContextLimit }: ContextEvidence): number {
	if (loadedContextLength) return loadedContextLength;
	if (details.numCtx) return details.numCtx;
	const trained = details.trainedContextLength ?? FALLBACK_CONTEXT_WINDOW;
	return serverContextLimit ? Math.min(trained, serverContextLimit) : trained;
}

/** Maps one Ollama model onto pi's OpenAI-compatible chat model shape. */
export function toPiModel(name: string, evidence: ContextEvidence, host: string): Model<"openai-completions"> {
	const { capabilities } = evidence.details;
	const reasoning = capabilities.includes("thinking");
	const contextWindow = effectiveContextWindow(evidence);
	return {
		id: name,
		name,
		api: "openai-completions",
		provider: OLLAMA_PROVIDER_ID,
		baseUrl: `${host}/v1`,
		reasoning,
		// Ollama reads "none" as thinking off; without it, thinking models default to thinking on.
		...(reasoning && { thinkingLevelMap: { off: "none", minimal: "low" } }),
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		// Field support per docs.ollama.com/api/openai-compatibility; reasoning streams as `reasoning`.
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		},
	};
}

/**
 * Normalizes OLLAMA_HOST as the Ollama CLI does: without a scheme the port defaults to 11434; with
 * one, to the scheme's default. A path prefix (reverse proxy) is kept, and bind-all means loopback.
 */
export function resolveOllamaHost(value: string | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) return DEFAULT_OLLAMA_HOST;
	const hasScheme = /^[a-z]+:\/\//i.test(trimmed);
	const url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
	if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
	if (!hasScheme && !url.port) url.port = "11434";
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** True for hosts that never leave this machine. */
export function isLoopback(baseUrl: string): boolean {
	const { hostname } = new URL(baseUrl);
	return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Persisted models discovered from this host only. A model's own baseUrl outranks the provider's,
 * so restoring another host's catalog would send requests to a server the user no longer configured.
 */
function storedOllamaModels(
	stored: Readonly<ModelsStoreEntry> | undefined,
	host: string,
): Model<"openai-completions">[] {
	return (stored?.models ?? []).filter(
		(model): model is Model<"openai-completions"> =>
			isModelType(model, "chat") &&
			model.provider === OLLAMA_PROVIDER_ID &&
			model.api === "openai-completions" &&
			model.baseUrl === `${host}/v1`,
	);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
