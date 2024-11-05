import {
  defaultPicture,
  generateTags,
  satsAbbrev,
  shortenEncodedId,
  updateProfiles,
} from "./util/ui.ts";
import { Show, createEffect, createSignal } from "solid-js";
import { UnsignedEvent, Event } from "nostr-tools/core";
import { EventSigner, pool, signersStore, store } from "./util/stores.ts";
import {
  generateSecretKey,
  getPublicKey,
  getEventHash,
  finalizeEvent,
} from "nostr-tools/pure";
import { createAutofocus } from "@solid-primitives/autofocus";
import { find, save, watch } from "./util/db.ts";
import { Profile, eventToNoteEvent } from "./util/models.ts";
import { lightningSvg, likeSvg } from "./thread.tsx";
import { decode, npubEncode } from "nostr-tools/nip19";
import { Relay } from "nostr-tools/relay";
import { normalizeURL } from "nostr-tools/utils";
import { nip04, nip44 } from "nostr-tools";
import { createNip07Signer } from "./util/helpers.ts";
import { addDM } from "./util/dm.ts";

export const ReplyEditor = (props: {
  replyTo?: string;
  onDone?: Function;
  onCancel?: Function;
  input?: boolean;
  isFocus?: boolean;
}) => {
  const [comment, setComment] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [isLoginProcess, setLoginProcess] = createSignal(false);
  const [loggedInUser, setLoggedInUser] = createSignal<Profile>();
  const [errorMessage, setErrorMessage] = createSignal("");

  const anchor = () => store.anchor!;
  const profiles = store.profiles!;
  const relays = () => store.relays!;
  const isNpubPro = store.npubPro === "true";
  const isDMmode = store.mode === "dm";

  // Sessions

  const login = async () => {
    if (isNpubPro) {
      setLoginProcess(true);
    }

    if (!window.nostr) {
      onError("Error: No NIP-07 extension!");
      return;
    }
    const pk = await window.nostr!.getPublicKey();

    signersStore.internal = createNip07Signer(pk, () =>
      Promise.resolve(window.nostr!)
    );

    setErrorMessage(""); // clear error
    signersStore.active = signersStore.internal;
  };

  // Logged in user is a computed property of the active signer
  createEffect(async () => {
    if (signersStore.active) {
      const pk = signersStore.active.pk;
      let profile = profiles().find((p) => p.pk === pk);
      if (!profile) {
        profile = { pk, l: 0, ts: 0 };
        await save("profiles", profile);
      }
      setLoggedInUser(profile);
      updateProfiles([pk], relays(), profiles());
    } else {
      setLoggedInUser();
    }
  });

  // for npubPro mode this will publish the
  // comment after login was executed
  createEffect(async () => {
    if (isNpubPro) {
      if (loggedInUser() && isLoginProcess()) {
        setLoginProcess(false);

        if (comment().length) {
          await publish(loggedInUser());
        }
      }
    }
  });

  // Publishing

  const onSuccess = async (event: Event, signer: EventSigner, notice?: string) => {
    setLoading(false);
    // reset comment & error message (unless supplied)
    setComment("");
    setErrorMessage(notice ?? "");

    const note = eventToNoteEvent(event as Event);
    if (isDMmode) await addDM(note, signer);
    await save("events", note, { immediate: true });

    // callback (closes the reply form)
    props.onDone?.call(this);
  };

  const onError = (message: string) => {
    setLoading(false);
    // set error message
    setErrorMessage(`Error: ${message}`);
  };

  const publish = async (profile?: Profile) => {
    let signer: EventSigner | undefined;
    if (profile) {
      signer = signersStore.active;
    } else {
      if (!signersStore.anonymous) {
        const sk = generateSecretKey();
        signersStore.anonymous = {
          pk: getPublicKey(sk),
          signEvent: async (event) => ({ sig: finalizeEvent(event, sk).sig }),
          nip04: {
            encrypt: (pubkey: string, data: string) =>
              nip04.encrypt(sk, pubkey, data),
            decrypt: (pubkey: string, data: string) =>
              nip04.decrypt(sk, pubkey, data),
          },
          nip44: {
            encrypt: (pubkey: string, data: string) =>
              Promise.resolve(
                nip44.encrypt(data, nip44.getConversationKey(sk, pubkey))
              ),
            decrypt: (pubkey: string, data: string) =>
              Promise.resolve(
                nip44.decrypt(data, nip44.getConversationKey(sk, pubkey))
              ),
          },
        };
      }
      signer = signersStore.anonymous;
    }

    if (!signer?.signEvent) {
      onError("Error: User has no signer!");
      return;
    }

    const content = comment().trim();
    if (!content) return;

    let unsignedEvent: UnsignedEvent;

    if (isDMmode) {
      let contentEncrypted = "";

      if (signer.nip04.encrypt) {
        contentEncrypted = await signer.nip04.encrypt(anchor().value, content);
      }

      unsignedEvent = {
        kind: 4,
        created_at: Math.round(Date.now() / 1000),
        content: contentEncrypted,
        pubkey: signer.pk,
        tags: [], // p-tag is added below
      };
    } else {
      unsignedEvent = {
        kind: 1, // kind 4
        created_at: Math.round(Date.now() / 1000),
        content: content, // encript signer.nip04.enccript('ancor', content)
        pubkey: signer.pk,
        tags: generateTags(content), // не надо, нужно tags: [['p', 'hex pubkey ancor']]
      };
    }

    if (store.anchorAuthor !== unsignedEvent.pubkey) {
      // Add p tag from note author to notify them
      unsignedEvent.tags.push(["p", store.anchorAuthor!]);
    }

    if (store.externalAuthor) {
      try {
        const pubkey = decode(store.externalAuthor).data as string;
        unsignedEvent.tags.push(["p", pubkey]);
      } catch (_) {}
    }

    if (store.client && !isDMmode) {
      unsignedEvent.tags.push(["client", store.client]);
    }

    // If it is a reply, prepare root and reply tags
    if (!isDMmode) {
      if (props.replyTo) {
        const replyEvent = await find(
          "events",
          IDBKeyRange.only(props.replyTo)
        );
        if (replyEvent) {
          // If it is a reply, it must have a root
          unsignedEvent.tags.push(["e", replyEvent.ro!, "", "root"]);
          // If the user is not replying to themselves, add p to notify
          if (replyEvent.pk !== unsignedEvent.pubkey) {
            unsignedEvent.tags.push(["p", replyEvent.pk]);
          }
        }
        unsignedEvent.tags.push(["e", props.replyTo, "", "reply"]);
      } else {
        // Otherwise find the root
        const rootEventId = store.version || store.rootEventIds[0];
        if (rootEventId) {
          unsignedEvent.tags.push(["e", rootEventId, "", "root"]);
        } else if (anchor().type === "http") {
          // If no root tag is present, create it to use as anchor
          const url = normalizeURL(anchor().value);
          const unsignedRootEvent: UnsignedEvent = {
            pubkey: signer.pk,
            created_at: Math.round(Date.now() / 1000),
            kind: 8812,
            tags: [["r", url]],
            content: `Comments on ${url} ↴`,
          };

          const rootEvent: Event = {
            id: getEventHash(unsignedRootEvent),
            ...unsignedRootEvent,
            ...(await signer.signEvent(unsignedRootEvent)),
          };

          save("events", eventToNoteEvent(rootEvent));

          // Publish, store filter and get updated rootTag
          if (store.disableFeatures!.includes("publish")) {
            console.log("Publishing root event disabled", rootEvent);
          } else {
            pool.publish(relays(), rootEvent);
          }
          // Update filter to this rootEvent
          store.filter = { "#e": [rootEvent.id] };
          unsignedEvent.tags.push(["e", rootEvent.id, "", "root"]);
        }
      }
    }

    if (anchor().type === "naddr") {
      unsignedEvent.tags.push(["a", anchor().value, "", "root"]);
    }

    const id = getEventHash(unsignedEvent);

    // Attempt to sign the event
    const signature = await signer.signEvent(unsignedEvent);

    const event: Event = { id, ...unsignedEvent, ...signature };

    setLoading(true);
    console.log(JSON.stringify(event, null, 2));

    if (store.disableFeatures!.includes("publish")) {
      // Simulate publishing
      setTimeout(() => onSuccess(event, signer!), 1000);
    } else {
      const failures: string[] = [];
      const promises = [];
      for (const relayUrl of relays()) {
        promises.push(
          new Promise<void>(async (ok) => {
            try {
              const relay = await Relay.connect(relayUrl);
              await relay.publish(event);
            } catch (e) {
              console.warn(e);
              failures.push(relayUrl);
            }
            ok();
          })
        );
      }

      // publish in parallel
      await Promise.allSettled(promises);

      if (failures.length === relays().length) {
        onError("Error: Your comment was not published to any relay");
      } else {
        const msg = `Published to ${failures.length}/${
          relays().length
        } relays (see console for more info)`;
        const notice = !isNpubPro && failures.length > 0 ? msg : undefined;
        onSuccess(event, signer!, notice);
      }
      // clear up failure log
      failures.length = 0;
    }
  };

  // Only autofocus if
  const autofocus = props.replyTo !== undefined;
  let ref!: HTMLInputElement & HTMLTextAreaElement;
  createAutofocus(() => (props.isFocus ? autofocus && ref : false));

  return (
    <div class="ztr-reply-form">
      {props.input ? (
        <input
          disabled={loading()}
          value={comment()}
          placeholder="Reply something..."
          autofocus={props.isFocus ? autofocus : false}
          ref={ref}
          onChange={(e) => setComment(e.target.value)}
        />
      ) : (
        <textarea
          disabled={loading()}
          value={comment()}
          placeholder={store.replyPlaceholder || "Add your comment..."}
          autofocus={autofocus}
          ref={ref}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      {isNpubPro && !loggedInUser() && (
        <div class="ztr-reply-controls">
          <button class="ztr-reply-login-button" onClick={() => login()}>
            {isDMmode ? 'Sent' : 'Reply'}
          </button>
        </div>
      )}
      {!(isNpubPro && !loggedInUser()) && (
        <div class="ztr-reply-controls">
          {store.disableFeatures!.includes("publish") && (
            <span>Publishing is disabled</span>
          )}
          {errorMessage() && (
            <span class="ztr-reply-error">Error: {errorMessage()}</span>
          )}

          <Show
            when={!loading()}
            fallback={
              <svg class="ztr-spinner" viewBox="0 0 50 50">
                <circle
                  class="path"
                  cx="25"
                  cy="25"
                  r="20"
                  fill="none"
                  stroke-width="5"
                ></circle>
              </svg>
            }
          >
            <div class="ztr-comment-info-picture">
              <img src={loggedInUser()?.i || defaultPicture} />
            </div>
          </Show>

          {loggedInUser() && (
            <>
                        {props.onCancel && <button
              disabled={loading()}
              class="ztr-reply-button ztr-reply-button--cancel"
              onClick={() => {if(props.onCancel) props.onCancel()}}
            >
              Cancel
            </button>}

            <button
              disabled={loading()}
              class="ztr-reply-button"
              onClick={() => publish(loggedInUser())}
            >
              {isNpubPro && <>{isDMmode ? 'Send' : 'Reply'}</>}
              {!isNpubPro && (
                <>
                  Reply as{" "}
                  {loggedInUser()!.n ||
                    shortenEncodedId(npubEncode(loggedInUser()!.pk))}
                </>
              )}
            </button>
            </>
          )}

          {!loggedInUser() &&
            !store.disableFeatures!.includes("replyAnonymously") && (
              <button
                disabled={loading()}
                class="ztr-reply-button"
                onClick={() => publish()}
              >
                {isDMmode ? 'Send anonymously' : 'Reply'}
              </button>
            )}

          {!loggedInUser() && (
            <button class="ztr-reply-login-button" onClick={() => login()}>
              Log in
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const RootComment = (props: { handleExitThread?: boolean }) => {
  const anchor = () => store.anchor!;
  const isDMmode = store.mode === "dm";

  const zapsAggregate = watch(() => [
    "aggregates",
    IDBKeyRange.only([anchor().value, 9735]),
  ]);
  const likesAggregate = watch(() => [
    "aggregates",
    IDBKeyRange.only([anchor().value, 7]),
  ]);
  const zapCount = () => zapsAggregate()?.sum ?? 0;
  const likeCount = () => likesAggregate()?.ids.length ?? 0;

  const handleExit = () => {
    if (props.handleExitThread) {
      store.activeThreadId = null;
    }
  };

  return (
    <div class="ztr-comment-new">
      <div class="ztr-comment-body">
        {!isDMmode && <ul class="ztr-comment-actions">
          <Show when={!store.disableFeatures!.includes("likes")}>
            <li class="ztr-comment-action-like">
              {likeSvg()}
              <span>{likeCount()} likes</span>
            </li>
          </Show>
          <Show when={!store.disableFeatures!.includes("zaps")}>
            <li class="ztr-comment-action-zap">
              {lightningSvg()}
              <span>{satsAbbrev(zapCount())} sats</span>
            </li>
          </Show>
        </ul>}
        <ReplyEditor onDone={() => handleExit()} />
      </div>
    </div>
  );
};
