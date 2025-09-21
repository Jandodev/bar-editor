// Viewport plugin system for Three.js "viewport as plugins"

import type { ResourceBus } from './resource-bus'

export type ViewportId = string

export interface ViewportContext {
  bus: ResourceBus
}

export interface ViewportInstance {
  mount(container: HTMLElement): void
  unmount(): void
  dispose(): void
}

export interface ViewportPlugin {
  id: ViewportId
  label: string
  create(ctx: ViewportContext): ViewportInstance
}

export class ViewportManager {
  private plugins = new Map<ViewportId, ViewportPlugin>()

  register(plugin: ViewportPlugin): void {
    if (this.plugins.has(plugin.id)) {
      console.warn(`ViewportManager: plugin already registered: ${plugin.id}, overriding.`)
    }
    this.plugins.set(plugin.id, plugin)
  }

  get(id: ViewportId): ViewportPlugin | undefined {
    return this.plugins.get(id)
  }

  list(): ViewportPlugin[] {
    return Array.from(this.plugins.values())
  }

  create(id: ViewportId, ctx: ViewportContext): ViewportInstance {
    const plugin = this.plugins.get(id)
    if (!plugin) {
      throw new Error(`ViewportManager: unknown plugin id "${id}"`)
    }
    return plugin.create(ctx)
  }
}

// Singleton registry for convenience
export const viewportManager = new ViewportManager()
