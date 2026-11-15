import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInitialState } from "./engine";
import type { MeshState } from "./types";

const directory = path.resolve(/* turbopackIgnore: true */ process.env.LEDGERMESH_DATA_DIR || ".data/ledgermesh");
const processStore = globalThis as typeof globalThis & { ledgerMeshTransactions?: Map<string, Promise<unknown>> };
const pending = processStore.ledgerMeshTransactions ??= new Map<string, Promise<unknown>>();
const SESSION_PATTERN = /^[a-f0-9]{64}$/;
export const SESSION_COOKIE = "ledgermesh_session";

export function sessionFor(request: Request): { id: string; fresh: boolean } {
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1);
  return value && SESSION_PATTERN.test(value) ? { id: value, fresh: false } : { id: randomBytes(32).toString("hex"), fresh: true };
}

function filename(id: string) {
  if (!SESSION_PATTERN.test(id)) throw new Error("Invalid workspace session.");
  return path.join(directory, `${id}.json`);
}

async function readState(id: string): Promise<MeshState> {
  try {
    const state = JSON.parse(await readFile(filename(id), "utf8")) as MeshState;
    if (state.version !== 1 || !Array.isArray(state.invoices)) throw new Error("Unsupported workspace data.");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createInitialState();
  }
}

async function writeState(id: string, state: MeshState) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename(id)}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, filename(id));
}

/** Serializes a complete read/change/write transaction in this Node process. */
export async function withWorkspace<T>(id: string, action: (state: MeshState) => Promise<{ state: MeshState; result: T }> | { state: MeshState; result: T }): Promise<T> {
  const previous = pending.get(id) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const output = await action(await readState(id));
    await writeState(id, output.state);
    return output.result;
  });
  pending.set(id, operation);
  try { return await operation; }
  finally { if (pending.get(id) === operation) pending.delete(id); }
}
