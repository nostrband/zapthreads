import { UnsignedEvent, finalizeEvent } from "nostr-tools";
import { NestedNoteEvent } from "./nest.js";
import { EventSignerExt } from "./stores.ts";

export const flattenEvents = (arr: NestedNoteEvent[]) => {
  let result: NestedNoteEvent[] = [];

  const flatten = (item: NestedNoteEvent) => {
    result.push({ ...item, children: [] });
    if (item.children && item.children.length > 0) {
      item.children.forEach(flatten);
    }
  };

  arr.forEach(flatten);
  return result;
};

export const createNip07Signer = (
  pubkey: string,
  getExt: () => Promise<EventSignerExt>,
  sk?: Uint8Array
) => {
  return {
    pk: pubkey,
    signEvent: async (event: UnsignedEvent) => {
      // Sign with private key if nsec was provided
      if (sk) {
        return { sig: finalizeEvent(event, sk).sig };
      }

      return (await getExt()).signEvent!(event);
    },
    nip04: {
      decrypt: async (pubkey: string, ciphertext: string) => {
        if (sk) throw new Error("Not supported");
        return (await getExt()).nip04.decrypt!(pubkey, ciphertext);
      },
      encrypt: async (pubkey: string, plaintext: string) => {
        if (sk) throw new Error("Not supported");
        return (await getExt()).nip04.encrypt!(pubkey, plaintext);
      },
    },
    nip44: {
      decrypt: async (pubkey: string, ciphertext: string) => {
        if (sk) throw new Error("Not supported");
        return (await getExt()).nip44.decrypt!(pubkey, ciphertext);
      },
      encrypt: async (pubkey: string, plaintext: string) => {
        if (sk) throw new Error("Not supported");
        return (await getExt()).nip44.encrypt!(pubkey, plaintext);
      },
    },
  };
};
