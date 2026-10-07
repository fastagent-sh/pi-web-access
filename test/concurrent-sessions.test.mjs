import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import initializeExtension from "../index.ts";
import { clearResults, getResult } from "../storage.ts";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

// A host that serves several conversations at once (an app or chat server built on the SDK)
// runs one extension instance per session, in one process. Each instance's session events
// must touch only its own results.
const started = [];
afterEach(async () => {
	// Every test ends every session it started, so the module's live-instance set is empty again.
	for (const instance of started.splice(0)) await instance.emit("session_shutdown");
	clearResults();
});

function startInstance(entries = []) {
	const tools = new Map();
	const handlers = new Map();
	initializeExtension({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut() {},
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
	});
	const ctx = {
		hasUI: false,
		model: undefined,
		modelRegistry: {},
		scopedModels: [],
		sessionManager: { getBranch: () => entries },
		ui: { setWidget() {}, notify() {} },
	};
	const emit = async (event) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};
	const call = (name, params) => tools.get(name).execute(`${name}-call`, params, undefined, undefined, ctx);
	const instance = { emit, call, entries };
	started.push(instance);
	return instance;
}

function servePage(text) {
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Page</title></head><body><article><h1>Page</h1><p>${text}</p></article></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);
}

const retrieve = async (instance, responseId) =>
	(await instance.call("get_search_content", { responseId, urlIndex: 0 })).content[0].text;

test("one session starting or ending leaves another session's stored results in place", async () => {
	servePage("Alpha content. ".repeat(80));
	const a = startInstance();
	await a.emit("session_start");
	const responseId = (await a.call("fetch_content", { url: "https://93.184.216.34/alpha" })).details.responseId;
	assert.ok(responseId);

	// Another conversation starts and ends while the first is mid-turn.
	const b = startInstance();
	await b.emit("session_start");
	await b.emit("session_shutdown");

	const text = await retrieve(a, responseId);
	assert.doesNotMatch(text, /No stored results/);
	assert.match(text, /Alpha content/);
});

test("a session's end releases only its own results, and its journal restores them", async () => {
	servePage("Beta content. ".repeat(80));
	const a = startInstance();
	const b = startInstance();
	await a.emit("session_start");
	await b.emit("session_start");
	const fromA = (await a.call("fetch_content", { url: "https://93.184.216.34/a" })).details.responseId;
	const fromB = (await b.call("fetch_content", { url: "https://93.184.216.34/b" })).details.responseId;

	await a.emit("session_shutdown");
	assert.equal(getResult(fromA), null);
	assert.ok(getResult(fromB));

	// The next turn of the first conversation is a new instance over the same journal.
	const again = startInstance([...a.entries]);
	await again.emit("session_start");
	assert.match(await retrieve(again, fromA), /Beta content/);
});

test("sessions forked from one history each keep the results they share", async () => {
	servePage("Shared content. ".repeat(80));
	const room = startInstance();
	await room.emit("session_start");
	const shared = (await room.call("fetch_content", { url: "https://93.184.216.34/shared" })).details.responseId;

	// A thread forked from the room carries the room's journal, so both hold the same id.
	const thread = startInstance([...room.entries]);
	await thread.emit("session_start");
	await thread.emit("session_shutdown");
	assert.match(await retrieve(room, shared), /Shared content/);

	await room.emit("session_shutdown");
	assert.equal(getResult(shared), null);
});
