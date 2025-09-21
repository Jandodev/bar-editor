<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'

const props = defineProps<{
  fps?: number
  peek?: boolean
}>()

const expanded = ref(false)
const history = ref<number[]>([])
const maxPoints = 180 // ~ last 3 minutes if fps emitted ~1/s
const canvasRef = ref<HTMLCanvasElement | null>(null)
const avg = ref<number | null>(null)
const min = ref<number | null>(null)
const max = ref<number | null>(null)
const targetFps = 60 // draw guide

function clampHistory() {
  while (history.value.length > maxPoints) history.value.shift()
}

function updateStats() {
  if (history.value.length === 0) {
    avg.value = min.value = max.value = null
    return
  }
  let s = 0
  let mi = Infinity
  let ma = -Infinity
  for (const v of history.value) {
    s += v
    if (v < mi) mi = v
    if (v > ma) ma = v
  }
  avg.value = Math.round((s / history.value.length) * 10) / 10
  min.value = mi
  max.value = ma
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const w = canvas.width
  const h = canvas.height

  // Background
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#0b0c0e'
  ctx.fillRect(0, 0, w, h)

  // Grid lines
  ctx.strokeStyle = '#1e2127'
  ctx.lineWidth = 1
  for (let y = 0; y <= h; y += 20) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(w, y + 0.5)
    ctx.stroke()
  }

  // Determine scale
  // Cap the graph at 120 fps to keep scale reasonable
  const cap = 120
  const guide = Math.min(targetFps, cap)
  const toY = (v: number) => {
    const clamped = Math.max(0, Math.min(cap, v))
    const ratio = clamped / cap
    return h - ratio * (h - 10) - 5 // 5px padding top/bottom
  }

  // Guide line at target FPS
  ctx.strokeStyle = '#3b4a6a'
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  const gy = toY(guide)
  ctx.moveTo(0, gy)
  ctx.lineTo(w, gy)
  ctx.stroke()
  ctx.setLineDash([])

  // Bars or line
  const n = history.value.length
  if (n > 0) {
    // Draw a polyline
    ctx.strokeStyle = '#8fd3ff'
    ctx.lineWidth = 2
    ctx.beginPath()
    // Left padding
    const pad = 4
    const usableW = w - pad * 2
    for (let i = 0; i < n; i++) {
      const x = pad + (i / Math.max(1, maxPoints - 1)) * usableW
      const y = toY(history.value[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // Labels
  ctx.fillStyle = '#8a93a6'
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'
  ctx.fillText(`${cap} fps`, 4, 10)
  ctx.fillText(`${guide} fps`, 4, gy - 4)
  ctx.fillText(`0`, 4, h - 4)
}

let drawRaf: number = 0
function scheduleDraw() {
  cancelAnimationFrame(drawRaf)
  drawRaf = requestAnimationFrame(draw)
}

watch(() => props.fps, (v) => {
  if (typeof v === 'number' && isFinite(v)) {
    history.value.push(v)
    clampHistory()
    updateStats()
    if (expanded.value) scheduleDraw()
  }
})

watch(expanded, (isOpen) => {
  if (isOpen) {
    // Ensure initial draw
    scheduleDraw()
  } else {
    cancelAnimationFrame(drawRaf)
  }
})

onMounted(() => {
  scheduleDraw()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(drawRaf)
})
</script>

<template>
  <div class="perf" :class="{ expanded, peek: props.peek }">
    <div class="header" v-if="!props.peek" @click="expanded = !expanded">
      <span class="title">Performance</span>
      <span class="dot">•</span>
      <span class="metric">FPS: {{ typeof fps === 'number' ? fps : '--' }}</span>
      <span class="spacer" />
      <span class="chev">{{ expanded ? '▼' : '▲' }}</span>
    </div>
    <div class="body" v-show="expanded || props.peek">
      <div class="stats">
        <div>Min: {{ min ?? '--' }}</div>
        <div>Avg: {{ avg ?? '--' }}</div>
        <div>Max: {{ max ?? '--' }}</div>
      </div>
      <canvas ref="canvasRef" :width="props.peek ? 220 : 340" :height="props.peek ? 60 : 120"></canvas>
    </div>
  </div>
</template>

<style scoped>
.perf {
  position: fixed;
  right: 12px;
  bottom: 28px; /* above StatusBar height */
  z-index: 10;
  width: 360px;
  color: #cfd4e6;
  background: #0f1115ee;
  border: 1px solid #222;
  border-radius: 6px;
  box-shadow: 0 6px 16px rgba(0,0,0,0.4);
  backdrop-filter: blur(2px);
  overflow: hidden;
}
.perf.peek {
  width: 240px;
}
.perf.peek .body {
  padding: 6px 8px 8px;
}
.perf.peek canvas {
  height: 60px;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  background: #11141a;
}
.title {
  color: #9fb0ff;
  font-weight: 600;
}
.dot {
  color: #4c515c;
}
.metric {
  color: #b9c2d1;
}
.spacer { flex: 1 1 auto; }
.chev {
  color: #8a93a6;
}

.body {
  padding: 8px 10px 10px;
}
.stats {
  display: inline-flex;
  gap: 12px;
  margin-bottom: 6px;
  color: #aeb5c6;
  font-size: 12px;
}
canvas {
  width: 100%;
  height: 120px;
  border: 1px solid #1f232a;
  background: #0b0c0e;
  border-radius: 4px;
  display: block;
}
</style>
