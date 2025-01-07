import {
  JSX,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { customElement } from "solid-element";
import style from "./styles/index.css?raw";
import {
  saveRelayLatestForFilter,
  updateProfiles,
  totalChildren,
  sortByDate,
  parseUrlPrefixes,
  parseContent,
  getRelayLatest as getRelayLatestForFilter,
  normalizeURL,
} from "./util/ui.ts";
import { nest } from "./util/nest.ts";
import {
  isDisableType,
  signersStore,
  PreferencesStore,
} from "./util/stores.ts";
import { Thread } from "./thread.tsx";
import { RootComment } from "./reply.tsx";
import { decode as bolt11Decode } from "light-bolt11-decoder";
import { find, findAll, save, watchAll } from "./util/db.ts";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { Filter } from "nostr-tools/filter";
import { AggregateEvent, NoteEvent, eventToNoteEvent } from "./util/models.ts";
// @ts-ignore
import { SimplePool, SubCloser } from "nostr-tools";
import { ThreadChatMode } from "./threadChatMode.js";
import { createNip07Signer } from "./util/helpers.js";
import { addDM, formatDMIndex, getDM } from "./util/dm.ts";
import { createMutable } from "solid-js/store";

const ZapThreads = (props: { [key: string]: string }) => {
  const [poolSignal] = createSignal(new SimplePool());
  const [storeSignal] = createSignal(
    createMutable<PreferencesStore>({
      rootEventIds: [],
      filter: {},
      profiles: () => [],
      activeThreadId: null,
      initialThreadId: null,
    })
  );
  const pool = poolSignal();
  const store = storeSignal();

  createComputed(() => {
    store.mode = props.mode ? props.mode : "";
    store.npubPro = props.npubPro ? props.npubPro : "";

    store.anchor = (() => {
      const anchor = props.anchor.trim();
      try {
        if (anchor.startsWith("http")) {
          const removeSlashes = !props.legacyUrl; // remove slashes if legacyUrl boolean not present
          return { type: "http", value: normalizeURL(anchor, removeSlashes) };
        }

        const decoded = decode(anchor);
        switch (decoded.type) {
          case "nevent":
            return { type: "note", value: decoded.data.id };
          case "note":
            return { type: "note", value: decoded.data };
          case "naddr":
            const d = decoded.data;
            return {
              type: "naddr",
              value: `${d.kind}:${d.pubkey}:${d.identifier}`,
            };
          case "npub":
            return { type: "npub", value: decoded.data };
        }
      } catch (e) {
        console.error(e);
        return { type: "error", value: `Malformed anchor: ${anchor}` };
      }
    })();

    const defaultRelays = "wss://relay.damus.io,wss://nos.lol";
    store.relays = (props.relays || defaultRelays)
      .split(",")
      .map((r) => new URL(r).toString());

    if ((props.author || "").startsWith("npub")) {
      store.externalAuthor = props.author;
    }

    store.disableFeatures = props.disable
      .split(",")
      .map((e) => e.trim())
      .filter(isDisableType);
    store.urlPrefixes = parseUrlPrefixes(props.urls);
    store.replyPlaceholder = props.replyPlaceholder;
    store.client = props.client;
  });

  const anchor = () => store.anchor!;
  const relays = () => store.relays!;
  const disableFeatures = () => store.disableFeatures!;
  const requestedVersion = () => props.version;

  const isChatMode = props.mode === "chat" || props.mode === "dm";
  const isDMMode = props.mode === "dm";

  store.profiles = watchAll(() => ["profiles"]);

  const closeOnEose = () => disableFeatures().includes("watch");

  // Login external npub/nsec
  const npubOrNsec = () => props.user;
  const activeSigner = () => signersStore.active;

  // Anchors -> root events -> events

  // clear version on anchor change
  createComputed(
    on([anchor], () => {
      store.version = requestedVersion();
    })
  );

  const [dmsReady, setDMsReady] = createSignal(false);

  // pre-decrypt dms
  createComputed(
    on([anchor, activeSigner], async () => {
      setDMsReady(false);
      const signer = activeSigner();
      if (anchor().type !== "npub" || !isDMMode || !signer) return;

      // fetch dms and decrypt
      const dmi = formatDMIndex(anchor().value, signer!.pk);
      const dms = await findAll("events", dmi, {
        index: "dm",
      });
      for (const dm of dms) await addDM(dm, signer!);
      setDMsReady(true);
    })
  );

  // Anchors -> root events
  createComputed(
    on([anchor, relays], async () => {
      if (anchor().type === "error") return;

      let filterForRemoteRootEvents: Filter;
      let localRootEvents: NoteEvent[] = [];

      // Find root events from anchor
      // We sort by date so that the IDs are kept in order before discarding the timestamp
      switch (anchor().type) {
        case "http":
          localRootEvents = await findAll("events", anchor().value, {
            index: "r",
          });
          store.rootEventIds = sortByDate(localRootEvents).map((e) => e.id);
          const rf = props.legacyUrl
            ? [anchor().value]
            : [anchor().value, `${anchor().value}/`];
          filterForRemoteRootEvents = { "#r": rf, kinds: [1, 8812] };
          break;
        case "note":
          // In the case of note we only have one possible anchor, so return if found
          const e = await find("events", IDBKeyRange.only(anchor().value));
          if (e) {
            localRootEvents = [e];
            store.rootEventIds = [e.id];
            store.anchorAuthor = e.pk;
            return;
          } else {
            localRootEvents = [];
            // queue to fetch from remote
            filterForRemoteRootEvents = { ids: [anchor().value] };
            break;
          }
        case "naddr":
          const [kind, pubkey, identifier] = anchor().value.split(":");
          localRootEvents = (
            await findAll("events", identifier, { index: "d" })
          ).filter((e) => e.pk === pubkey);
          if (localRootEvents.length > 0) {
            store.rootEventIds = sortByDate(localRootEvents).map((e) => e.id);
            store.anchorAuthor = localRootEvents[0].pk;
          }
          filterForRemoteRootEvents = {
            authors: [pubkey],
            kinds: [parseInt(kind)],
            "#d": [identifier],
          };
          break;
        case "npub":
          // FIXME also need localRootEvents from cache
          filterForRemoteRootEvents = { authors: [anchor().value], kinds: [0] };
          break;
        default:
          throw "error";
      }

      // No `since` here as we are not keeping track of a since for root events
      const remoteRootEvents = await pool.querySync(relays(), {
        ...filterForRemoteRootEvents,
      });

      const remoteRootNoteEvents = remoteRootEvents.map(eventToNoteEvent);
      for (const e of remoteRootNoteEvents) {
        if (anchor().type == "http") {
          // make sure it's an actual anchor and not a random comment with that URL
          if ((e.k == 1 && e.c.includes("↴")) || e.k == 8812) {
            save("events", e);
          }
        } else {
          save("events", e);
        }
      }

      switch (anchor().type) {
        case "http":
        case "naddr":
        case "npub":
          const events = [...localRootEvents, ...remoteRootNoteEvents];
          const sortedEventIds = sortByDate([...events]).map((e) => e.id);
          // only set root event ids if we have a newer event from remote
          if (
            (sortedEventIds.length > 0 && sortedEventIds[0]) !==
            store.rootEventIds[0]
          ) {
            store.rootEventIds = sortedEventIds;
          }
          break;
        case "note":
          store.rootEventIds = remoteRootNoteEvents.map((e) => e.id);
          break;
      }

      if (remoteRootNoteEvents.length > 0) {
        store.anchorAuthor = remoteRootNoteEvents[0].pk;
      }
    })
  );

  const rootEventIds = () => store.rootEventIds;

  // Root events -> filter
  createComputed(
    on(
      [rootEventIds, requestedVersion],
      () => {
        // set the filter for finding actual comments
        switch (anchor().type) {
          case "http":
          case "note":
            if (
              (store.filter["#e"] ?? []).toString() !==
              rootEventIds().toString()
            ) {
              store.filter = { "#e": rootEventIds() };
            }
            return;
          case "naddr":
            const existingAnchor = store.filter["#a"] && store.filter["#a"][0];
            if (anchor().value !== existingAnchor) {
              store.filter = { "#a": [anchor().value] };
            }

            // Version only applicable to naddr - get provided version or default to most recent root event ID
            store.version = requestedVersion() || rootEventIds()[0];
            return;
          case "npub":
            const signer = signersStore.active;
            if (!isDMMode || !signer) {
              store.filter = {};
              return;
            }
            const userPubkey = signer.pk;
            store.filter = {
              "#p": [anchor().value, userPubkey],
              authors: [anchor().value, userPubkey],
            };

            return;
        }
      },
      { defer: true }
    )
  );

  // Subscription

  const filter = createMemo(
    () => {
      return store.filter;
    },
    { defer: true }
  );

  let sub: SubCloser | null = null;

  // Filter -> remote events, content
  createEffect(
    on(
      [filter],
      async () => {
        // Fix values to this effect
        const _filter = filter();
        const _relays = relays();
        const _anchor = anchor();
        const _events = events();
        const _profiles = store.profiles();

        if (Object.entries(_filter).length === 0) {
          return;
        }

        // Ensure clean subs
        sub?.close();
        sub = null;

        onCleanup(() => {
          console.log(
            "[zapthreads] unsubscribing and cleaning up",
            _anchor.value
          );
          sub?.close();
          sub = null;
        });

        let kinds = [1, 9802, 7, 9735];

        if (isDMMode) {
          kinds = [4];
        }
        // TODO restore with a specific `since` for aggregates
        // (leaving it like this will fail when re-enabling likes/zaps)
        // if (!store.disableFeatures().includes('likes')) {
        //   kinds.push(7);
        // }
        // if (!store.disableFeatures().includes('zaps')) {
        //   kinds.push(9735);
        // }

        console.log("[zapthreads] subscribing to", _anchor.value);

        const since = await getRelayLatestForFilter(_anchor, _relays);

        const newLikeIds = new Set<string>();
        const newZaps: { [id: string]: string } = {};

        sub = pool.subscribeMany(_relays, [{ ..._filter, kinds, since }], {
          onevent(e) {
            // console.log({ e });
            if (e.kind === 1 || e.kind === 9802) {
              if (e.content.trim()) {
                save("events", eventToNoteEvent(e));
              }
            } else if (e.kind === 7) {
              newLikeIds.add(e.id);
            } else if (e.kind === 9735) {
              const invoiceTag = e.tags.find((t) => t[0] === "bolt11");
              invoiceTag && invoiceTag[1] && (newZaps[e.id] = invoiceTag[1]);
            } else if (e.kind === 4) {
              // decrypt and store in RAM, to avoid writing decrypted
              // events to the database
              const note = eventToNoteEvent(e);
              addDM(note, signersStore.active).then(() => save("events", note));
            }
          },
          oneose() {
            (async () => {
              const likesAggregate: AggregateEvent = (await find(
                "aggregates",
                IDBKeyRange.only([_anchor.value, 7])
              )) ?? { eid: _anchor.value, ids: [], k: 7 };
              likesAggregate.ids = [
                ...new Set([...likesAggregate.ids, ...newLikeIds]),
              ];
              save("aggregates", likesAggregate);

              const zapsAggregate: AggregateEvent = (await find(
                "aggregates",
                IDBKeyRange.only([_anchor.value, 9735])
              )) ?? { eid: _anchor.value, ids: [], k: 9735, sum: 0 };
              zapsAggregate.sum = Object.entries(newZaps).reduce(
                (acc, entry) => {
                  if (zapsAggregate.ids.includes(entry[0])) return acc;
                  const decoded = bolt11Decode(entry[1]);
                  const amount = decoded.sections.find(
                    (e: { name: string }) => e.name === "amount"
                  );
                  const sats = Number(amount.value) / 1000;
                  return acc + sats;
                },
                zapsAggregate.sum ?? 0
              );

              zapsAggregate.ids = [
                ...new Set([...zapsAggregate.ids, ...Object.keys(newZaps)]),
              ];
              save("aggregates", zapsAggregate);
            })();

            setTimeout(async () => {
              // Update profiles of current events (includes anchor author)
              await updateProfiles(
                pool,
                [..._events.map((e) => e.pk)],
                _relays,
                _profiles
              );

              // Save latest received events for each relay
              saveRelayLatestForFilter(pool, _anchor, _events);

              if (closeOnEose()) {
                sub?.close();
                pool.close(_relays);
              }
            }, 96); // same as batched throttle in db.ts
          },
        });
      },
      { defer: true }
    )
  );

  // Auto login when external pubkey supplied
  createComputed(
    on(npubOrNsec, (_) => {
      if (_) {
        let pubkey: string;
        let sk: Uint8Array | undefined;
        if (_.startsWith("nsec")) {
          sk = decode(_).data as Uint8Array;
          pubkey = getPublicKey(sk);
        } else if (_.startsWith("npub")) {
          pubkey = decode(_).data as string;
        } else {
          pubkey = _;
        }

        const getExt = async () => {
          // We validate here in order to delay prompting the user as much as possible
          if (!window.nostr) {
            alert(
              "Please log in with a NIP-07 extension such as Alby or nos2x"
            );
            signersStore.active = undefined;
            throw "No extension available";
          }

          const extensionPubkey = await window.nostr!.getPublicKey();
          const loggedInPubkey = pubkey;
          if (loggedInPubkey !== extensionPubkey) {
            // If zapthreads was passed a different pubkey then error
            const error = `ERROR: Event not signed. Supplied pubkey does not match extension pubkey. ${loggedInPubkey} !== ${extensionPubkey}`;
            signersStore.active = undefined;
            alert(error);
            throw error;
          } else {
            return window.nostr!;
          }
        };

        signersStore.external = createNip07Signer(pubkey, getExt, sk);
        signersStore.active = signersStore.external;
      }
    })
  );

  // Log out when external npub/nsec is absent
  createComputed(
    on(
      npubOrNsec,
      (_) => {
        if (!_) {
          signersStore.active = undefined;
        }
      },
      { defer: true }
    )
  );

  const articles = watchAll(() => ["events", 30023, { index: "k" }]);

  const content = createMemo(() => {
    if (
      store.disableFeatures!.includes("hideContent") &&
      anchor().type === "naddr"
    ) {
      const [_, pubkey, identifier] = anchor().value.split(":");
      const contentEvent = articles().find(
        (e) => e.d === identifier && e.pk === pubkey
      );

      if (contentEvent) {
        const c = `# ${contentEvent.tl}\n ${contentEvent.c}`;
        return parseContent({ ...contentEvent, c }, store, []);
      }
    }
  });

  // Build JSX

  // Watch all events
  const eventsWatcher = createMemo(() => {
    const hexUser = signersStore.active?.pk;

    switch (anchor().type) {
      case "http":
      case "note":
        return watchAll(() => ["events", store.rootEventIds, { index: "ro" }]);
      case "naddr":
        return watchAll(() => ["events", anchor().value, { index: "a" }]);
      case "npub":
        if (isDMMode && hexUser) {
          const dm = formatDMIndex(anchor().value, hexUser);
          return watchAll(() => ["events", dm, { index: "dm" }]);
        }
    }
    // error
    return () => [];
  });
  const events = () => eventsWatcher()();

  // Filter -> local events
  const nestedEvents = createMemo(() => {
    // calculate only once root event IDs are ready

    if (store.rootEventIds && store.rootEventIds.length) {
      const nested = nest(events());
      return nested
        .filter((e) => {
          // remove all highlights without children (we only want those that have comments on them)
          return !(e.k === 9802 && e.children.length === 0);
        })
        .map((e) => {
          // get decrypted content from RAM
          if (e.k === 4 && dmsReady()) e.c = getDM(e.id) || e.c;
          return e;
        });
    }
    return [];
  });

  const commentsLength = () => {
    return nestedEvents().reduce(
      (acc, n) => acc + totalChildren(n),
      nestedEvents().length
    );
  };

  // const [showAdvanced, setShowAdvanced] = createSignal(false);

  const classRoot = isDMMode ? "ztr-root--message" : "";
  const classRootComment = isDMMode ? "ztr-root-comment-editor--message" : "";

  createEffect(() => {
    commentsLength();
  });

  return (
    <>
      <div id="ztr-root" class={classRoot}>
        <style>{style}</style>
        {content() && <div id="ztr-content" innerHTML={content()}></div>}
        {anchor().type === "error" && (
          <>
            <h1>Error!</h1>
            <div class="ztr-comment-text">
              <pre>{anchor().value}</pre>
              <p>
                Only properly formed NIP-19 naddr, note and nevent encoded
                entities and URLs are supported.
              </p>
            </div>
          </>
        )}
        {anchor().type !== "error" && (
          <>
            {!isDMMode && (
              <>
                {!store.disableFeatures!.includes("reply") && (
                  <RootComment
                    pool={pool}
                    store={store}
                    handleExitThread={true}
                  />
                )}
              </>
            )}
            {!isDMMode && (
              <h2 id="ztr-title">
                {commentsLength() > 0 &&
                  `${commentsLength()} comment${
                    commentsLength() == 1 ? "" : "s"
                  }`}
              </h2>
            )}
            {isChatMode ? (
              <ThreadChatMode
                pool={pool}
                store={store}
                child={false}
                nestedEvents={nestedEvents}
                articles={articles}
              />
            ) : (
              <Thread
                pool={pool}
                store={store}
                nestedEvents={nestedEvents}
                articles={articles}
              />
            )}
            {isDMMode && (
              <div class={classRootComment}>
                {!store.disableFeatures!.includes("reply") && (
                  <RootComment
                    pool={pool}
                    store={store}
                    handleExitThread={true}
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* <div
          style="float:right; opacity: 0.2;"
          onClick={() => setShowAdvanced(!showAdvanced())}
        >
          {ellipsisSvg()}
        </div>
        {showAdvanced() && (
          <>
            <p>
              Powered by{" "}
              <a href="https://github.com/fr4nzap/zapthreads">zapthreads</a>
            </p>
            {store.version && <p>Anchor version: {store.version}</p>}
            <button onClick={clearCache}>Clear cache</button>
          </>
        )} */}
      </div>
    </>
  );
};

export default ZapThreads;

// NOTE that the element seems to lose reactivity (in Solid, at least)
// when using multiple word attributes
customElement<ZapThreadsAttributes>(
  "zap-threads",
  {
    anchor: "",
    version: "",
    mode: "",
    npubpro: "",
    relays: "",
    user: "",
    author: "",
    disable: "",
    urls: "",
    client: "",
    "reply-placeholder": "",
    "legacy-url": "",
  },
  (props) => {
    return (
      <ZapThreads
        anchor={props["anchor"] ?? ""}
        version={props["version"] ?? ""}
        mode={props["mode"] ?? ""}
        npubPro={props["npubpro"] ?? ""}
        relays={props["relays"] ?? ""}
        user={props["user"] ?? ""}
        author={props["author"] ?? ""}
        disable={props["disable"] ?? ""}
        urls={props["urls"] ?? ""}
        client={props["client"] ?? ""}
        replyPlaceholder={props["reply-placeholder"] ?? ""}
        legacyUrl={props["legacy-url"] ?? ""}
      />
    );
  }
);

export type ZapThreadsAttributes = {
  [key in
    | "anchor"
    | "version"
    | "relays"
    | "user"
    | "author"
    | "disable"
    | "urls"
    | "reply-placeholder"
    | "legacy-url"
    | "mode"
    | "client"
    | "npubpro"]?: string;
} & JSX.HTMLAttributes<HTMLElement>;
