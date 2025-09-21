// Simple ResourceBus for sharing editor state between the app and viewport plugins.
// - get/set for key-value resources
// - subscribe/unsubscribe for key changes
// - batch publish to update multiple keys atomically

export type Unsubscribe = () => void

export interface ResourceBus {
  get<T = unknown>(key: string): T | undefined
  set<T = unknown>(key: string, value: T): void
  publish(entries: Record<string, unknown>): void
  subscribe<T = unknown>(key: string, cb: (value: T) => void): Unsubscribe
  // Utility: read a snapshot of selected keys
  snapshot<T extends Record<string, any>>(keys: (keyof T & string)[]): Partial<T>
}

type Listener = (value: unknown) => void

export function createResourceBus(initial?: Record<string, unknown>): ResourceBus {
  const store = new Map<string, unknown>()
  const listeners = new Map<string, Set<Listener>>()

  if (initial && typeof initial === 'object') {
    for (const [k, v] of Object.entries(initial)) store.set(k, v)
  }

  const get = <T = unknown>(key: string): T | undefined => {
    return store.get(key) as T | undefined
  }

  const set = <T = unknown>(key: string, value: T): void => {
    store.set(key, value as unknown)
    const subs = listeners.get(key)
    if (subs) {
      for (const cb of subs) {
        try {
          cb(value as unknown)
        } catch (e) {
          console.warn('ResourceBus subscriber error for key:', key, e)
        }
      }
    }
  }

  const publish = (entries: Record<string, unknown>): void => {
    // Set first, then notify, to allow subscribers to read other updated keys during callbacks
    const changed: string[] = []
    for (const [k, v] of Object.entries(entries)) {
      store.set(k, v)
      changed.push(k)
    }
    for (const k of changed) {
      const subs = listeners.get(k)
      if (subs) {
        const v = store.get(k)
        for (const cb of subs) {
          try {
            cb(v)
          } catch (e) {
            console.warn('ResourceBus subscriber error for key:', k, e)
          }
        }
      }
    }
  }

  const subscribe = <T = unknown>(key: string, cb: (value: T) => void): Unsubscribe => {
    let setForKey = listeners.get(key)
    if (!setForKey) {
      setForKey = new Set()
      listeners.set(key, setForKey)
    }
    const wrapped: Listener = (v) => cb(v as T)
    setForKey.add(wrapped)
    return () => {
      const s = listeners.get(key)
      if (!s) return
      s.delete(wrapped)
      if (s.size === 0) listeners.delete(key)
    }
  }

  const snapshot = <T extends Record<string, any>>(keys: (keyof T & string)[]): Partial<T> => {
    const out: Record<string, any> = {}
    for (const k of keys) out[k] = store.get(k)
    return out as Partial<T>
  }

  return { get, set, publish, subscribe, snapshot }
}

// Suggested keys for the editor bus. These are recommendations; plugins can read any keys as agreed by convention.
export type EditorBusKeys = {
  // Terrain/geometry
  'terrain': {
    widthWorld: number
    lengthWorld: number
    gridW: number
    gridL: number
    heights: Float32Array
  } | undefined

  // Metal overlay
  'metal': {
    showMetal?: boolean
    metalU8?: Uint8Array
    metalW?: number
    metalL?: number
  } | undefined

  // Base texture
  'baseTexture': {
    url?: string | null
    isDDS?: boolean
  } | undefined

  // Arbitrary overlays
  'overlays': {
    name: string
    url: string
    visible: boolean
    opacity: number
    isDDS?: boolean
  }[] | undefined

  // Display toggles
  'display': {
    wireframe?: boolean
    showGrid?: boolean
  } | undefined

  // Environment
  'env': {
    ambient?: [number, number, number]
    sunColor?: [number, number, number]
    sunDir?: [number, number, number]
    skyColor?: [number, number, number]
    fogStart?: number
    fogEnd?: number
    fogColor?: [number, number, number]
  } | undefined
}
