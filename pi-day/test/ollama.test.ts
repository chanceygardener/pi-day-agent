// Tests the Ollama provider against a real HTTP stub that serves Ollama's native API shapes.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { OllamaClient, OllamaProtocolError } from "../extensions/ollama/client.ts";
import {
	DEFAULT_OLLAMA_HOST,
	effectiveContextWindow,
	fetchOllamaCatalog,
	isLoopback,
	refreshOllamaModels,
	resolveOllamaHost,
	toPiModel,
} from "../extensions/ollama/provider.ts";

type StubRoutes = Record<string, unknown>;

const SHOW_RESPONSES: Record<string, unknown> = {
	"qwen-vision:27b": {
		capabilities: ["completion", "vision", "tools", "thinking"],
		model_info: { "qwen35.context_length": 262144 },
		parameters: "temperature 1\ntop_k 20",
	},
	"r1:8b": {
		capabilities: ["completion", "tools", "thinking"],
		// The rope-scaling key must not be mistaken for the context length.
		model_info: { "qwen3.rope.scaling.original_context_length": 32768, "qwen3.context_length": 131072 },
		parameters: "num_ctx 16384",
	},
	"embed-only": { capabilities: ["embedding"], model_info: {}, parameters: "" },
};

const DEFAULT_ROUTES: StubRoutes = {
	"/api/tags": { models: Object.keys(SHOW_RESPONSES).map((name) => ({ name })) },
	"/api/ps": { models: [{ name: "qwen-vision:27b", context_length: 65536 }] },
};

function startStub(routes: StubRoutes, status = 200): Promise<Server> {
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const payload =
				request.url === "/api/show"
					? SHOW_RESPONSES[(JSON.parse(body) as { model: string }).model]
					: routes[request.url ?? ""];
			response.writeHead(payload === undefined ? 404 : status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(payload ?? {}));
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function hostOf(server: Server): string {
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): {
	context: RefreshModelsContext;
	published: ModelsPublication[];
} {
	const published: ModelsPublication[] = [];
	const context: RefreshModelsContext = {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			published.push(publication);
			return true;
		},
		...overrides,
	};
	return { context, published };
}

/** A persisted catalog discovered from `host`, plus another provider's model that must never be restored. */
function storedFor(host: string): ModelsStoreEntry {
	const model = toPiModel("stored:1b", { details: { capabilities: ["tools"], trainedContextLength: 8192 } }, host);
	return { models: [model, { ...model, id: "other", provider: "openai" }], checkedAt: 1 };
}

const REMOTE_HOST = "http://ollama.invalid:11434";

describe("effectiveContextWindow", () => {
	const details = { capabilities: [], trainedContextLength: 131072, numCtx: 16384 };

	it("prefers the allocation of a loaded model", () => {
		assert.equal(effectiveContextWindow({ details, loadedContextLength: 65536, serverContextLimit: 4096 }), 65536);
	});

	it("uses the Modelfile num_ctx when the model is not loaded", () => {
		assert.equal(effectiveContextWindow({ details, serverContextLimit: 4096 }), 16384);
	});

	it("caps the trained length by OLLAMA_CONTEXT_LENGTH", () => {
		const unconfigured = { capabilities: [], trainedContextLength: 131072 };
		assert.equal(effectiveContextWindow({ details: unconfigured, serverContextLimit: 32768 }), 32768);
		assert.equal(effectiveContextWindow({ details: unconfigured }), 131072);
	});

	it("falls back to Ollama's smallest default when nothing is reported", () => {
		assert.equal(effectiveContextWindow({ details: { capabilities: [] } }), 4096);
	});
});

describe("resolveOllamaHost", () => {
	it("normalizes the forms OLLAMA_HOST accepts", () => {
		assert.equal(resolveOllamaHost(undefined), DEFAULT_OLLAMA_HOST);
		assert.equal(resolveOllamaHost("  "), DEFAULT_OLLAMA_HOST);
		assert.equal(resolveOllamaHost("0.0.0.0:11434"), "http://127.0.0.1:11434");
		assert.equal(resolveOllamaHost("gpu-box"), "http://gpu-box:11434");
		assert.equal(resolveOllamaHost("https://ollama.example.com"), "https://ollama.example.com");
		assert.equal(resolveOllamaHost("http://gpu-box:8080/"), "http://gpu-box:8080");
	});

	it("uses the scheme's default port when a scheme is given, and keeps a path prefix", () => {
		assert.equal(resolveOllamaHost("http://gpu-box"), "http://gpu-box");
		assert.equal(resolveOllamaHost("http://proxy.local/ollama/"), "http://proxy.local/ollama");
	});
});

describe("fetchOllamaCatalog", () => {
	let server: Server;
	before(async () => {
		server = await startStub(DEFAULT_ROUTES);
	});
	after(() => server.close());

	it("lists only tool-capable models with their capabilities and context", async () => {
		const models = await fetchOllamaCatalog(
			new OllamaClient(hostOf(server)),
			undefined,
			new AbortController().signal,
		);
		assert.deepEqual(
			models.map(({ id, input, reasoning, contextWindow }) => ({ id, input, reasoning, contextWindow })),
			[
				{ id: "qwen-vision:27b", input: ["text", "image"], reasoning: true, contextWindow: 65536 },
				{ id: "r1:8b", input: ["text"], reasoning: true, contextWindow: 16384 },
			],
		);
		assert.equal(models[0].baseUrl, `${hostOf(server)}/v1`);
		assert.deepEqual(models[0].thinkingLevelMap, { off: "none", minimal: "low" });
	});
});

describe("isLoopback", () => {
	it("accepts only hosts that never leave this machine", () => {
		assert.equal(isLoopback("http://127.0.0.1:11434"), true);
		assert.equal(isLoopback("http://127.1.2.3:11434"), true);
		assert.equal(isLoopback("http://localhost:11434"), true);
		assert.equal(isLoopback("http://[::1]:11434"), true);
		assert.equal(isLoopback("http://gpu-box:11434"), false);
		assert.equal(isLoopback("http://127.example.com:11434"), false);
	});
});

describe("refreshOllamaModels", () => {
	it("restores only persisted Ollama models for a remote host when network access is not allowed", async () => {
		// A remote host must not be contacted at all; .invalid never resolves, so a request would fail loudly.
		const { context, published } = refreshContext({ allowNetwork: false, stored: storedFor(REMOTE_HOST) });
		const models = await refreshOllamaModels(new OllamaClient(REMOTE_HOST), undefined, context);
		assert.deepEqual(
			models.map((model) => model.id),
			["stored:1b"],
		);
		assert.equal(published.length, 0);
	});

	it("never restores a catalog persisted for a different host", async () => {
		// Restored models keep their own baseUrl, so another host's catalog would route requests there.
		const remoteCatalog = refreshContext({ allowNetwork: false, stored: storedFor(REMOTE_HOST) });
		const localCatalog = refreshContext({ allowNetwork: false, stored: storedFor(DEFAULT_OLLAMA_HOST) });
		const closed = await startStub(DEFAULT_ROUTES);
		const downLoopback = hostOf(closed);
		await new Promise((resolve) => closed.close(resolve));
		// Remote catalog, now configured for a loopback server that is down: must not route prompts off-machine.
		assert.deepEqual(await refreshOllamaModels(new OllamaClient(downLoopback), undefined, remoteCatalog.context), []);
		// Local catalog, now configured for a remote host while offline: must not keep pointing at the old server.
		assert.deepEqual(await refreshOllamaModels(new OllamaClient(REMOTE_HOST), undefined, localCatalog.context), []);
	});

	it("still discovers a loopback server when network access is not allowed", async () => {
		const server = await startStub(DEFAULT_ROUTES);
		try {
			const { context } = refreshContext({ allowNetwork: false, stored: storedFor(hostOf(server)) });
			const models = await refreshOllamaModels(new OllamaClient(hostOf(server)), undefined, context);
			assert.deepEqual(
				models.map((model) => model.id),
				["qwen-vision:27b", "r1:8b"],
			);
		} finally {
			server.close();
		}
	});

	it("keeps the persisted catalog when discovery exceeds its deadline", async () => {
		const hung = createServer(() => {});
		await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
		try {
			const { context } = refreshContext({ stored: storedFor(hostOf(hung)) });
			const models = await refreshOllamaModels(new OllamaClient(hostOf(hung)), undefined, context, 50);
			assert.deepEqual(
				models.map((model) => model.id),
				["stored:1b"],
			);
		} finally {
			hung.closeAllConnections();
			hung.close();
		}
	});

	it("keeps the persisted catalog when the server is down", async () => {
		const closed = await startStub(DEFAULT_ROUTES);
		const host = hostOf(closed);
		await new Promise((resolve) => closed.close(resolve));
		const { context } = refreshContext({ stored: storedFor(host) });
		const models = await refreshOllamaModels(new OllamaClient(host), undefined, context);
		assert.deepEqual(
			models.map((model) => model.id),
			["stored:1b"],
		);
	});

	it("persists and returns the live catalog when the server answers", async () => {
		const server = await startStub(DEFAULT_ROUTES);
		try {
			const { context, published } = refreshContext({ stored: storedFor(hostOf(server)) });
			const models = await refreshOllamaModels(new OllamaClient(hostOf(server)), undefined, context);
			assert.deepEqual(
				models.map((model) => model.id),
				["qwen-vision:27b", "r1:8b"],
			);
			assert.deepEqual(published[0].persist?.models, models);
		} finally {
			server.close();
		}
	});

	it("surfaces protocol errors instead of hiding them behind the stored catalog", async () => {
		const server = await startStub(DEFAULT_ROUTES, 500);
		try {
			const { context } = refreshContext({ stored: storedFor(hostOf(server)) });
			await assert.rejects(
				refreshOllamaModels(new OllamaClient(hostOf(server)), undefined, context),
				OllamaProtocolError,
			);
		} finally {
			server.close();
		}
	});
});
