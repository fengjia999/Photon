import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./settings.js";

test("settings persist across restarts and serialize concurrent saves", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "data", "settings.json");
  const defaults = { model: "env-model", timeEnabled: true, debounceSeconds: 30 };
  const store = await SettingsStore.open(path, defaults);
  assert.deepEqual(store.get(), defaults);
  await Promise.all([
    store.save({ model: "first", timeEnabled: true }),
    store.save({ model: " second ", timeEnabled: false }),
  ]);
  assert.deepEqual(store.get(), { model: "second", timeEnabled: false, debounceSeconds: 30 });
  assert.deepEqual((await SettingsStore.open(path, defaults)).get(), store.get());
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), store.get());
  await store.save({ model: "", timeEnabled: true });
  assert.equal((await SettingsStore.open(path, defaults)).get().model, "");
});

test("invalid updates and failed writes keep active settings unchanged", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocker = join(directory, "data");
  const defaults = { model: "original", timeEnabled: true, debounceSeconds: 30 };
  const store = await SettingsStore.open(join(blocker, "settings.json"), defaults);
  for (const invalid of [{ model: "x", timeEnabled: "false" }, { model: "x\n", timeEnabled: true }, { ...defaults, secret: "oops" }]) {
    assert.throws(() => store.save(invalid));
  }
  await writeFile(blocker, "not a directory");
  await assert.rejects(store.save({ model: "new", timeEnabled: false }));
  assert.deepEqual(store.get(), defaults);
  await rm(blocker);
  await store.save({ model: "recovered", timeEnabled: false });
  assert.equal(store.get().model, "recovered");
});

test("legacy settings default to 30 seconds; changes persist and old clients preserve the delay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({ model: "old", timeEnabled: false }));
  const store = await SettingsStore.open(path, { model: "", timeEnabled: true });
  assert.equal(store.get().debounceSeconds, 30);
  for (const debounceSeconds of [0, 45, 300]) {
    await store.save({ ...store.get(), debounceSeconds });
    assert.equal((await SettingsStore.open(path, { model: "", timeEnabled: true })).get().debounceSeconds, debounceSeconds);
  }
  await store.save({ model: "new", timeEnabled: true });
  assert.equal(store.get().debounceSeconds, 300);
  for (const debounceSeconds of [-1, 301, 1.5, "30", null, NaN, Infinity]) {
    assert.throws(() => store.save({ ...store.get(), debounceSeconds }));
  }
  assert.equal(store.get().debounceSeconds, 300);
});

test("corrupt persisted settings are reported instead of silently reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  await writeFile(path, "broken JSON");
  await assert.rejects(SettingsStore.open(path, { model: "", timeEnabled: true }));
});
