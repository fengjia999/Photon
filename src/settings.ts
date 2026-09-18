import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type BridgeSettings = { model: string; timeEnabled: boolean };

export function validateSettings(value: unknown): BridgeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid settings");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => key !== "model" && key !== "timeEnabled")
    || typeof data.model !== "string" || data.model.length > 200
    || /[\u0000-\u001f\u007f]/u.test(data.model)
    || typeof data.timeEnabled !== "boolean") throw new Error("invalid settings");
  return { model: data.model.trim(), timeEnabled: data.timeEnabled };
}

export class SettingsStore {
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private value: BridgeSettings) {}

  static async open(path: string, defaults: BridgeSettings): Promise<SettingsStore> {
    let value = validateSettings(defaults);
    try {
      value = validateSettings(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new SettingsStore(path, value);
  }

  get(): BridgeSettings { return { ...this.value }; }

  save(input: unknown): Promise<void> {
    const next = validateSettings(input);
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.value = next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
