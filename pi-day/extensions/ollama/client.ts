// HTTP client for the Ollama native endpoints that describe installed and loaded models.

/** Capabilities and context limits Ollama reports for one installed model (POST /api/show). */
export interface OllamaModelDetails {
	capabilities: readonly string[];
	/** Trained context length from `model_info.<arch>.context_length`. */
	trainedContextLength?: number;
	/** `num_ctx` set by the model's Modelfile parameters. */
	numCtx?: number;
}

/** Ollama could not be reached; an expected state when the server is not running. */
export class OllamaUnavailableError extends Error {
	constructor(baseUrl: string, options: { cause: unknown }) {
		super(`Ollama is not reachable at ${baseUrl}`, options);
		this.name = "OllamaUnavailableError";
	}
}

/** Ollama answered with a status or payload this client does not understand. */
export class OllamaProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OllamaProtocolError";
	}
}

/** Reads model metadata from one Ollama server. */
export class OllamaClient {
	readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	/** Names of every installed model (GET /api/tags). */
	async listModelNames(signal: AbortSignal): Promise<string[]> {
		return parseTags(await this.request("/api/tags", { method: "GET" }, signal));
	}

	/** Capabilities and context limits of one installed model (POST /api/show). */
	async showModel(name: string, signal: AbortSignal): Promise<OllamaModelDetails> {
		const body = JSON.stringify({ model: name });
		return parseShow(await this.request("/api/show", { method: "POST", body }, signal));
	}

	/** Allocated context length of each model currently loaded in memory (GET /api/ps). */
	async loadedContextLengths(signal: AbortSignal): Promise<Map<string, number>> {
		return parsePs(await this.request("/api/ps", { method: "GET" }, signal));
	}

	private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, { ...init, signal });
		} catch (error) {
			if (signal.aborted) throw error;
			throw new OllamaUnavailableError(this.baseUrl, { cause: error });
		}
		if (!response.ok) throw new OllamaProtocolError(`Ollama ${path} returned HTTP ${response.status}`);
		return response.json();
	}
}

// Wire-format parsers: Ollama responses are untrusted input, so each field is checked here.

function parseTags(payload: unknown): string[] {
	const models = recordField(payload, "models", "/api/tags");
	if (!Array.isArray(models)) throw new OllamaProtocolError("/api/tags: `models` is not an array");
	return models.map((model) => stringField(model, "name", "/api/tags"));
}

function parseShow(payload: unknown): OllamaModelDetails {
	const capabilities = recordField(payload, "capabilities", "/api/show");
	const modelInfo = recordField(payload, "model_info", "/api/show");
	const parameters = recordField(payload, "parameters", "/api/show");
	return {
		capabilities: Array.isArray(capabilities) ? capabilities.filter((item) => typeof item === "string") : [],
		trainedContextLength: trainedContextLength(modelInfo),
		numCtx: typeof parameters === "string" ? numCtxParameter(parameters) : undefined,
	};
}

function parsePs(payload: unknown): Map<string, number> {
	const models = recordField(payload, "models", "/api/ps");
	if (!Array.isArray(models)) throw new OllamaProtocolError("/api/ps: `models` is not an array");
	const lengths = new Map<string, number>();
	for (const model of models) {
		const contextLength = recordField(model, "context_length", "/api/ps");
		if (isPositiveInteger(contextLength)) lengths.set(stringField(model, "name", "/api/ps"), contextLength);
	}
	return lengths;
}

/** `model_info` keys are prefixed by architecture, e.g. `qwen3.context_length`. */
function trainedContextLength(modelInfo: unknown): number | undefined {
	if (!isRecord(modelInfo)) return undefined;
	const entry = Object.entries(modelInfo).find(([key]) => key.endsWith(".context_length"));
	return entry && isPositiveInteger(entry[1]) ? entry[1] : undefined;
}

/** `parameters` is Modelfile text with one `name value` pair per line. */
function numCtxParameter(parameters: string): number | undefined {
	const match = /^num_ctx\s+(\d+)\s*$/m.exec(parameters);
	return match ? Number(match[1]) : undefined;
}

function recordField(value: unknown, field: string, endpoint: string): unknown {
	if (!isRecord(value)) throw new OllamaProtocolError(`${endpoint}: expected a JSON object`);
	return value[field];
}

function stringField(value: unknown, field: string, endpoint: string): string {
	const fieldValue = recordField(value, field, endpoint);
	if (typeof fieldValue !== "string") throw new OllamaProtocolError(`${endpoint}: \`${field}\` is not a string`);
	return fieldValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
