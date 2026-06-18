// IndexedDB persistence: media/sequence-frame blobs + project documents.
// (v1 stored the project in localStorage; we migrate it into IDB on first boot.)
import type { Project } from "./types";
import { migrate } from "./state/migrations";

const DB_NAME = "wge-media";
const DB_VERSION = 2;
const BLOB_STORE = "blobs";
const PROJECT_STORE = "projects";
const LS_LAST = "rrv-last-project";
const LS_V1 = "wge-project-v1"; // legacy

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
      if (!db.objectStoreNames.contains(PROJECT_STORE))
        db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }),
  );
}

// ---- blobs (media + sequence frames) ----
export async function putBlob(id: string, blob: Blob): Promise<void> {
  await tx(BLOB_STORE, "readwrite", (s) => s.put(blob, id));
}
export async function getBlob(id: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(BLOB_STORE, "readonly", (s) => s.get(id));
}
export async function deleteBlob(id: string): Promise<void> {
  await tx(BLOB_STORE, "readwrite", (s) => s.delete(id));
}

// ---- projects ----
interface StoredProject {
  id: string;
  name: string;
  updatedAt: number;
  data: Project;
}

export async function saveProject(p: Project, when = 0): Promise<void> {
  const serializable: Project = {
    ...p,
    media: p.media.map((m) => ({ ...m, url: undefined })),
  };
  const record: StoredProject = {
    id: p.id,
    name: p.name,
    updatedAt: when,
    data: serializable,
  };
  await tx(PROJECT_STORE, "readwrite", (s) => s.put(record));
  try {
    localStorage.setItem(LS_LAST, p.id);
  } catch {
    /* ignore */
  }
}

export async function loadProject(id?: string): Promise<Project | null> {
  // legacy localStorage project → migrate into IDB once
  const legacy = localStorage.getItem(LS_V1);
  if (legacy) {
    try {
      const migrated = migrate(JSON.parse(legacy));
      await saveProject(migrated);
      localStorage.removeItem(LS_V1);
      localStorage.setItem(LS_LAST, migrated.id);
      return migrated;
    } catch {
      localStorage.removeItem(LS_V1);
    }
  }
  const targetId = id ?? localStorage.getItem(LS_LAST) ?? undefined;
  if (!targetId) {
    // fall back to most recent project if any
    const all = await listProjects();
    if (all.length === 0) return null;
    const rec = await tx<StoredProject | undefined>(PROJECT_STORE, "readonly", (s) =>
      s.get(all[0].id),
    );
    return rec ? migrate(rec.data) : null;
  }
  const rec = await tx<StoredProject | undefined>(PROJECT_STORE, "readonly", (s) =>
    s.get(targetId),
  );
  return rec ? migrate(rec.data) : null;
}

export async function listProjects(): Promise<
  { id: string; name: string; updatedAt: number }[]
> {
  const all = await tx<StoredProject[]>(PROJECT_STORE, "readonly", (s) => s.getAll());
  return all
    .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await tx(PROJECT_STORE, "readwrite", (s) => s.delete(id));
}
