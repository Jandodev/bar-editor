<script setup lang="ts">
const props = defineProps<{
  hasHeights: boolean
  files: number
  mapName?: string
  error?: string | null
  fps?: number
}>()

const emit = defineEmits<{ (e: 'fpsHover', hovering: boolean): void; (e: 'fpsClick'): void }>()
</script>

<template>
  <div class="statusbar">
    <div class="left">
      <span class="badge" :class="hasHeights ? 'ok' : 'warn'">
        {{ hasHeights ? 'Geometry loaded' : 'No geometry' }}
      </span>
      <span class="sep">•</span>
      <span class="item">Files: {{ files }}</span>
      <span class="sep">•</span>
      <span
        class="item"
        @mouseenter="emit('fpsHover', true)"
        @mouseleave="emit('fpsHover', false)"
        @click="emit('fpsClick')"
      >
        FPS: {{ typeof fps === 'number' ? fps : '--' }}
      </span>
      <span v-if="mapName" class="sep">•</span>
      <span v-if="mapName" class="item">Map: {{ mapName }}</span>
    </div>
    <div class="right">
      <span v-if="error" class="error">Error: {{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 28px;
  padding: 0 10px;
  border-top: 1px solid #222;
  background: #0f1115;
  color: #cfd4e6;
  font-size: 12px;
}
.left, .right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.badge {
  padding: 2px 6px;
  border-radius: 10px;
  border: 1px solid #2a2a2a;
  background: #15171b;
}
.badge.ok {
  color: #9fffb0;
  border-color: #204b2a;
  background: #0e1a12;
}
.badge.warn {
  color: #ffaa80;
  border-color: #4b2a20;
  background: #1a120e;
}
.item {
  color: #aeb5c6;
}
.sep {
  color: #4c515c;
}
.error {
  color: #ff7676;
}
</style>
