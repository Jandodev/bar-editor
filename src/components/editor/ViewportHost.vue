<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { ResourceBus } from '../../lib/editor/resource-bus'
import { viewportManager, type ViewportInstance } from '../../lib/editor/viewport-manager'
import BrushHUD from './BrushHUD.vue'

type Props = {
  pluginId: string
  bus: ResourceBus
  buttonLabel?: string
}
const props = defineProps<Props>()

const mountEl = ref<HTMLDivElement | null>(null)
let instance: ViewportInstance | null = null

onMounted(() => {
  const plugin = viewportManager.get(props.pluginId)
  if (!plugin) {
    console.warn('ViewportHost: plugin not found:', props.pluginId)
    return
  }
  instance = plugin.create({ bus: props.bus })
  if (mountEl.value) instance.mount(mountEl.value)
})

onBeforeUnmount(() => {
  try { instance?.unmount() } catch {}
  try { instance?.dispose() } catch {}
  instance = null
})

function onTopButtonClick() {
  if (props.pluginId === 'orthographic') {
    const ortho = (props.bus.get('ortho') as any) || {}
    const q = (((ortho.screenRotationQuarter ?? 0) + 1) % 4)
    props.bus.set('ortho', { ...ortho, screenRotationQuarter: q })
  } else {
    const display = (props.bus.get('display') as any) || {}
    props.bus.set('display', { ...display, showGrid: !(display.showGrid ?? true) })
  }
}

function onAtlasToggle() {
  if (props.pluginId !== 'orthographic') return
  const ortho = (props.bus.get('ortho') as any) || {}
  const view = String(ortho.view || 'terrain')
  const next = view === 'atlas' ? 'terrain' : 'atlas'
  props.bus.set('ortho', { ...ortho, view: next })
}
function onProfilerToggle() {
  if (props.pluginId !== 'orthographic') return
  const ortho = (props.bus.get('ortho') as any) || {}
  const view = String(ortho.view || 'terrain')
  const next = view === 'profiler' ? 'terrain' : 'profiler'
  props.bus.set('ortho', { ...ortho, view: next })
}
</script>

<template>
  <div class="viewport-host">
    <div class="overlay">
      <div class="btn-row">
        <button class="overlay-btn" @click="onTopButtonClick">{{ buttonLabel ?? (pluginId === 'orthographic' ? 'Rotate 90°' : 'Toggle Grid') }}</button>
        <button v-if="pluginId === 'orthographic'" class="overlay-btn" @click="onAtlasToggle">Toggle Atlas</button>
        <button v-if="pluginId === 'orthographic'" class="overlay-btn" @click="onProfilerToggle">Profiler</button>
      </div>
    </div>
    <!-- Brush Heads-Up Display overlay (mouse-first controls) -->
    <BrushHUD v-if="pluginId === 'perspective'" :bus="props.bus" />
    <div class="mount" ref="mountEl"></div>
  </div>
</template>

<style scoped>
.viewport-host {
  position: relative;
  width: 100%;
  height: 100%;
  background: #0e0f12;
  border: 1px solid #222;
}
.mount {
  position: absolute;
  inset: 0;
}
.overlay {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  pointer-events: auto;
}
.overlay-btn {
  padding: 4px 10px;
  font-size: 12px;
  background: rgba(20, 22, 28, 0.9);
  border: 1px solid #2a2a2a;
  color: #e6e6e6;
  border-radius: 14px;
  cursor: pointer;
}
.overlay-btn:hover {
  background: rgba(34, 36, 44, 0.95);
}
.btn-row {
  display: inline-flex;
  gap: 6px;
}
</style>
