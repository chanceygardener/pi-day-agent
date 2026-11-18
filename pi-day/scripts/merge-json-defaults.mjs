// Fills missing keys of a JSON config file from a defaults file without overriding existing values.
// Usage: node merge-json-defaults.mjs <target.json> <defaults.json>
// Objects merge recursively; any existing value, arrays included, wins over its default, so items a
// user removed stay removed. `${VAR}` in default strings expands from the environment, so setup can
// inject resolved install paths.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [targetPath, defaultsPath] = process.argv.slice(2);
if (!targetPath || !defaultsPath) {
	console.error("usage: merge-json-defaults.mjs <target.json> <defaults.json>");
	process.exit(2);
}

const target = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, "utf8")) : {};
const defaults = expandEnv(JSON.parse(readFileSync(defaultsPath, "utf8")));
mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, `${JSON.stringify(mergeDefaults(target, defaults), null, "\t")}\n`);

function mergeDefaults(existing, fallback) {
	if (existing === undefined) return fallback;
	if (isPlainObject(existing) && isPlainObject(fallback)) {
		const keys = new Set([...Object.keys(existing), ...Object.keys(fallback)]);
		return Object.fromEntries([...keys].map((key) => [key, mergeDefaults(existing[key], fallback[key])]));
	}
	return existing;
}

function expandEnv(value) {
	if (typeof value === "string") {
		return value.replace(/\$\{(\w+)\}/g, (_, name) => {
			const resolved = process.env[name];
			if (resolved === undefined) throw new Error(`${defaultsPath}: \${${name}} is not set`);
			return resolved;
		});
	}
	if (Array.isArray(value)) return value.map(expandEnv);
	if (isPlainObject(value))
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item)]));
	return value;
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
