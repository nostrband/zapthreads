import { EventSigner } from "./stores.ts";
import { NoteEvent } from "./models.ts";

const dms = new Map<string, string>();

export function formatDMIndex(pubkeyA: string, pubkeyB: string) {
  return [pubkeyA, pubkeyB].sort().join(",");
}

export async function addDM(e: NoteEvent, signer?: EventSigner) {
  if (dms.get(e.id)) return;
  if (signer && e.po) {
    const peer = e.pk === signer.pk ? e.po : e.pk;
    const c = await signer.nip04.decrypt!(peer, e.c);
    dms.set(e.id, c);
  }
}

export function getDM(id: string): string | undefined {
  const c = dms.get(id);
  return c;
}
