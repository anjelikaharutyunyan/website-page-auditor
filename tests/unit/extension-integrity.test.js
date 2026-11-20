// Static checks: manifest validity, referenced files exist, permissions stay minimal, engine load order.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const manifest = JSON.parse(read("manifest.json"));

test("manifest is MV3 with a service worker, popup and side panel", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(exists(manifest.background.service_worker));
  assert.ok(exists(manifest.action.default_popup));
  assert.ok(exists(manifest.side_panel.default_path));
  for (const icon of Object.values(manifest.icons)) assert.ok(exists(icon), icon);
});

test("permissions are least-privilege", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "debugger", "scripting", "sidePanel", "storage"]);
  assert.equal(manifest.host_permissions, undefined, "no install-time host access");
  assert.equal(manifest.content_scripts, undefined, "nothing is injected automatically");
  assert.equal(manifest.web_accessible_resources, undefined);
  // Chrome rejects "debugger" in optional_permissions, so it must stay a required permission.
  assert.equal(manifest.optional_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
});

test("locale messages used by the manifest exist", () => {
  const messages = JSON.parse(read("_locales/en/messages.json"));
  for (const key of [manifest.name, manifest.description]) {
    const m = key.match(/^__MSG_(\w+)__$/);
    if (m) assert.ok(messages[m[1]], m[1]);
  }
});

test("store name and description follow Chrome Web Store limits", () => {
  const messages = JSON.parse(read("_locales/en/messages.json"));
  const name = messages.extensionName.message;
  const description = messages.extensionDescription.message;
  assert.ok(description.length <= 132, `description is ${description.length} characters`);
  assert.ok(name.length <= 75, `name is ${name.length} characters`);
  assert.ok(!/chrome|google/i.test(name), "name must not imply Google made or endorses the extension");
  assert.equal(manifest.action.default_title, name);
});

test("privacy policy ships with the extension and is linked from the dashboard", () => {
  assert.ok(exists("privacy.html"));
  assert.ok(read("popup.html").includes('href="privacy.html"'));
});

test("background engine file list exists and loads dependencies first", () => {
  const bg = read("js/background.js");
  const list = JSON.parse(bg.match(/const ENGINE_FILES = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
  for (const f of list) assert.ok(exists(f), f);
  const idx = (f) => list.indexOf(`js/qa/${f}`);
  assert.equal(idx("qa-utils.js"), 0);
  assert.equal(idx("core.js"), 1);
  assert.ok(idx("form-tests.js") < idx("search-tests.js"), "search uses form helpers");
  assert.equal(list[list.length - 1], "js/qa/runner.js");
  for (const f of fs.readdirSync(path.join(ROOT, "js/qa"))) assert.ok(list.includes(`js/qa/${f}`), `${f} is not injected`);
  for (const m of bg.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const s of m[1].match(/"[^"]+"/g)) assert.ok(exists(path.join("js", JSON.parse(s))), s);
  }
  for (const m of bg.matchAll(/files: \[([^\]]*)\]/g)) {
    for (const s of m[1].match(/"[^"]+"/g) || []) assert.ok(exists(JSON.parse(s)), s);
  }
});

test("popup references only existing local scripts and styles", () => {
  const html = read("popup.html");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  assert.ok(refs.length >= 4);
  for (const r of refs) assert.ok(exists(r), r);
  assert.ok(!/<script>(?!<)/.test(html), "no inline scripts (CSP)");
  assert.ok(!/\son[a-z]+="/i.test(html), "no inline event handlers (CSP)");
});

test("every element id used by popup.js exists in popup.html", () => {
  const html = read("popup.html");
  const js = read("js/popup.js");
  const ids = new Set([...js.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `#${id} missing`);
});

test("every message type sent by the popup has a background handler", () => {
  const bg = read("js/background.js");
  const js = read("js/popup.js");
  const types = new Set([...js.matchAll(/send\("(qa:[\w]+)"/g)].map((m) => m[1]));
  assert.ok(types.size > 5);
  for (const t of types) assert.ok(bg.includes(`"${t}"`), `${t} has no handler`);
});

test("engine never reads form values into results", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "js/qa"))) {
    const src = read(`js/qa/${f}`);
    assert.ok(!/evidence:\s*\{[^}]*\bvalue:\s*\w+\.value\b/.test(src), `${f} puts a field value into evidence`);
  }
});

test("no removed legacy files remain referenced", () => {
  const all = ["manifest.json", "popup.html", "js/background.js", "js/popup.js"].map(read).join("\n");
  for (const legacy of ["cookiesFunctions", "content-bridge", "bootstrap", "seoFunctions", "disableFunctions", "main.js"]) {
    assert.ok(!all.includes(legacy), legacy);
  }
});
