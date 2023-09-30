import {
  relayInit,
  type Relay,
  type Sub,
  type SubscriptionOptions
} from './relay.ts'
import {normalizeURL} from './utils.ts'

import type {Event} from './event.ts'
import {matchFilters, type Filter} from './filter.ts'

type BatchedRequest = {
  filters: Filter<any>[]
  relays: string[]
  resolve: (events: Event<any>[]) => void
  events: Event<any>[]
}

export class SimplePool {
  _conn: {[url: string]: Relay}
  private _seenOn: {[id: string]: Set<string>} = {} // a map of all events we've seen in each relay
  private batchedByKey: {[batchKey: string]: BatchedRequest[]} = {}

  private eoseSubTimeout: number
  private getTimeout: number
  private seenOnEnabled: boolean = true
  private batchInterval: number = 100

  constructor(
    options: {
      eoseSubTimeout?: number
      getTimeout?: number
      seenOnEnabled?: boolean
      batchInterval?: number
    } = {}
  ) {
    this._conn = {}
    this.eoseSubTimeout = options.eoseSubTimeout || 3400
    this.getTimeout = options.getTimeout || 3400
    this.seenOnEnabled = options.seenOnEnabled !== false
    this.batchInterval = options.batchInterval || 100
  }

  close(relays: string[]): void {
    relays.forEach(url => {
      let relay = this._conn[normalizeURL(url)]
      if (relay) relay.close()
    })
  }

  async ensureRelay(url: string): Promise<Relay> {
    const nm = normalizeURL(url)

    if (!this._conn[nm]) {
      this._conn[nm] = relayInit(nm, {
        getTimeout: this.getTimeout * 0.9,
        listTimeout: this.getTimeout * 0.9
      })
    }

    const relay = this._conn[nm]
    await relay.connect()
    return relay
  }

  sub<K extends number = number>(
    relays: string[],
    filters: Filter<K>[],
    opts?: SubscriptionOptions
  ): Sub<K> {
    let _knownIds: Set<string> = new Set()
    let modifiedOpts = {...(opts || {})}
    modifiedOpts.alreadyHaveEvent = (id, url) => {
      if (opts?.alreadyHaveEvent?.(id, url)) {
        return true
      }
      if (this.seenOnEnabled) {
        let set = this._seenOn[id] || new Set()
        set.add(url)
        this._seenOn[id] = set
      }
      return _knownIds.has(id)
    }

    let subs: Sub[] = []
    let eventListeners: Set<any> = new Set()
    let eoseListeners: Set<() => void> = new Set()
    let eosesMissing = relays.length

    let eoseSent = false
    let eoseTimeout = setTimeout(() => {
      eoseSent = true
      for (let cb of eoseListeners.values()) cb()
    }, this.eoseSubTimeout)

    relays
      .filter((r, i, a) => a.indexOf(r) == i)
      .forEach(async relay => {
        let r
        try {
          r = await this.ensureRelay(relay)
        } catch (err) {
          handleEose()
          return
        }
        if (!r) return
        let s = r.sub(filters, modifiedOpts)
        s.on('event', event => {
          _knownIds.add(event.id as string)
          for (let cb of eventListeners.values()) cb(event)
        })
        s.on('eose', () => {
          if (eoseSent) return
          handleEose()
        })
        subs.push(s)

        function handleEose() {
          eosesMissing--
          if (eosesMissing === 0) {
            clearTimeout(eoseTimeout)
            for (let cb of eoseListeners.values()) cb()
          }
        }
      })

    let greaterSub: Sub = {
      sub(filters, opts) {
        subs.forEach(sub => sub.sub(filters, opts))
        return greaterSub
      },
      unsub() {
        subs.forEach(sub => sub.unsub())
      },
      on(type, cb) {
        if (type === 'event') {
          eventListeners.add(cb)
        } else if (type === 'eose') {
          eoseListeners.add(cb as () => void | Promise<void>)
        }
      },
      off(type, cb) {
        if (type === 'event') {
          eventListeners.delete(cb)
        } else if (type === 'eose')
          eoseListeners.delete(cb as () => void | Promise<void>)
      }
    }

    return greaterSub
  }

  get<K extends number = number>(
    relays: string[],
    filter: Filter<K>,
    opts?: SubscriptionOptions
  ): Promise<Event<K> | null> {
    return new Promise(resolve => {
      let sub = this.sub(relays, [filter], opts)
      let timeout = setTimeout(() => {
        sub.unsub()
        resolve(null)
      }, this.getTimeout)
      sub.on('event', event => {
        resolve(event)
        clearTimeout(timeout)
        sub.unsub()
      })
    })
  }

  list<K extends number = number>(
    relays: string[],
    filters: Filter<K>[],
    opts?: SubscriptionOptions
  ): Promise<Event<K>[]> {
    return new Promise(resolve => {
      let events: Event<K>[] = []
      let sub = this.sub(relays, filters, opts)

      sub.on('event', event => {
        events.push(event)
      })

      // we can rely on an eose being emitted here because pool.sub() will fake one
      sub.on('eose', () => {
        sub.unsub()
        resolve(events)
      })
    })
  }

  batchedList<K extends number = number>(
    batchKey: string,
    relays: string[],
    filters: Filter<K>[]
  ): Promise<Event<K>[]> {
    return new Promise(resolve => {
      if (!this.batchedByKey[batchKey]) {
        this.batchedByKey[batchKey] = [
          {
            filters,
            relays,
            resolve,
            events: []
          }
        ]

        setTimeout(() => {
          Object.keys(this.batchedByKey).forEach(async batchKey => {
            const batchedRequests = this.batchedByKey[batchKey]

            const filters = [] as Filter[]
            const relays = [] as string[]
            batchedRequests.forEach(br => {
              filters.push(...br.filters)
              relays.push(...br.relays)
            })

            const sub = this.sub(relays, filters)
            sub.on('event', event => {
              batchedRequests.forEach(
                br => matchFilters(br.filters, event) && br.events.push(event)
              )
            })
            sub.on('eose', () => {
              sub.unsub()
              batchedRequests.forEach(br => br.resolve(br.events))
            })

            delete this.batchedByKey[batchKey]
          })
        }, this.batchInterval)
      } else {
        this.batchedByKey[batchKey].push({
          filters,
          relays,
          resolve,
          events: []
        })
      }
    })
  }

  publish(relays: string[], event: Event<number>): Promise<void>[] {
    return relays.map(async relay => {
      let r = await this.ensureRelay(relay)
      r.publish(event)
    })
  }

  seenOn(id: string): string[] {
    return Array.from(this._seenOn[id]?.values?.() || [])
  }
}