// pi-day extension entry point: registers the local Ollama server as the `ollama` provider.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOllamaProviderConfig, OLLAMA_PROVIDER_ID } from "./provider.ts";

export default function ollamaExtension(pi: ExtensionAPI): void {
	pi.registerProvider(OLLAMA_PROVIDER_ID, createOllamaProviderConfig());
}
