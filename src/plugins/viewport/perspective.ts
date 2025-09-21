import { createApp, h, type App as VueApp } from 'vue'
import type { ViewportPlugin, ViewportInstance, ViewportContext } from '../../lib/editor/viewport-manager'
import ViewportFromBus from '../../components/editor/ViewportFromBus.vue'

export const perspectiveViewportPlugin: ViewportPlugin = {
  id: 'perspective',
  label: 'Perspective',
  create(ctx: ViewportContext): ViewportInstance {
    let app: VueApp<Element> | null = null
    let mountedEl: HTMLElement | null = null

    return {
      mount(container: HTMLElement) {
        mountedEl = container
        app = createApp({
          render() {
            return h(ViewportFromBus as any, {
              bus: ctx.bus,
              mode: 'perspective',
            })
          },
        })
        app.mount(container)
      },
      unmount() {
        if (app) {
          app.unmount()
          app = null
        }
        if (mountedEl) {
          try {
            // Optional: clear container
            while (mountedEl.firstChild) mountedEl.removeChild(mountedEl.firstChild)
          } catch {}
        }
      },
      dispose() {
        // nothing extra; underlying components handle WebGL disposal
      },
    }
  },
}
