// Portable project bundles: a single .rrvproj JSON containing the project plus
// every referenced media/sequence-frame blob (base64). Enables backup/sharing.
import type { Project } from "./types";
import { getBlob, putBlob, saveProject } from "./storage";
import { migrate } from "./state/migrations";
import { newId } from "./types";

interface Bundle {
  format: "rrvproj";
  version: 1;
  project: Project;
  blobs: Record<string, string>; // blobId -> dataURL
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return r.blob();
}

/** Collect every blob id a project references. */
function referencedBlobIds(p: Project): string[] {
  const ids = new Set<string>();
  for (const m of p.media) {
    if (m.type === "sequence") (m.frameBlobIds ?? []).forEach((id) => ids.add(id));
    else ids.add(m.id);
  }
  return [...ids];
}

export async function exportProjectBundle(p: Project): Promise<Blob> {
  const blobs: Record<string, string> = {};
  for (const id of referencedBlobIds(p)) {
    const b = await getBlob(id);
    if (b) blobs[id] = await blobToDataURL(b);
  }
  const bundle: Bundle = {
    format: "rrvproj",
    version: 1,
    project: { ...p, media: p.media.map((m) => ({ ...m, url: undefined })) },
    blobs,
  };
  return new Blob([JSON.stringify(bundle)], { type: "application/json" });
}

export async function importProjectBundle(file: File): Promise<Project> {
  const text = await file.text();
  const bundle = JSON.parse(text) as Bundle;
  if (bundle.format !== "rrvproj") throw new Error("Not an RR Video project file");
  for (const [id, url] of Object.entries(bundle.blobs)) {
    await putBlob(id, await dataURLToBlob(url));
  }
  // Give the imported project a fresh id so it doesn't clobber an existing one.
  const project = migrate(bundle.project);
  project.id = newId("proj");
  project.name = `${project.name} (imported)`;
  await saveProject(project, Date.now());
  return project;
}
