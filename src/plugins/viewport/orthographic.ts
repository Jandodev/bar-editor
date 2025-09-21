import { createApp, h, type App as VueApp } from 'vue'
import type { ViewportPlugin, ViewportInstance, ViewportContext } from '../../lib/editor/viewport-manager'
import ViewportFromBus from '../../components/editor/ViewportFromBus.vue'

export const orthographicViewportPlugin: ViewportPlugin = {
  id: 'orthographic',
  label: 'Orthographic',
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
              mode: 'orthographic',
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
            while (mountedEl.firstChild) mountedEl.removeChild(mountedEl.firstChild)
          } catch {}
        }
      },
      dispose() {
        // no-op
      },
    }
  },
}
