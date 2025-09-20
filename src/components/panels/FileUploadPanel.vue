<script setup lang="ts">
const props = defineProps<{
  hasHeights: boolean
  dirPickerSupported: boolean
  autoResolveAfterSmf: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  (e: 'changeSmf', ev: Event): void
  (e: 'changePackage', ev: Event): void
  (e: 'changeFolder', ev: Event): void
  (e: 'changeMapinfo', ev: Event): void
  (e: 'resolveFolder'): void
  (e: 'update:autoResolveAfterSmf', value: boolean): void
}>()

function onToggleAutoResolve(ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked
  emit('update:autoResolveAfterSmf', checked)
}
</script>

<template>
  <div class="section">
    <h3>Load</h3>
    <label class="file">
      <input type="file" accept=".smf,application/octet-stream" @change="(e) => emit('changeSmf', e)" />
      <span>Load .smf</span>
    </label>
    <label class="file">
      <input type="file" accept=".sdz,.zip,.sd7" @change="(e) => emit('changePackage', e)" />
      <span>Load map package (.sdz/.zip)</span>
    </label>
    <label class="file">
      <input type="file" webkitdirectory directory multiple @change="(e) => emit('changeFolder', e)" />
      <span>Load map folder</span>
    </label>
    <label class="file">
      <input type="file" accept=".lua" @change="(e) => emit('changeMapinfo', e)" />
      <span>Load mapinfo.lua</span>
    </label>

    <button class="file" v-if="hasHeights && dirPickerSupported" @click="emit('resolveFolder')">
      <span>Resolve assets from folder</span>
    </button>

    <label class="toggle" v-if="dirPickerSupported">
      <input type="checkbox" :checked="autoResolveAfterSmf" @change="onToggleAutoResolve" />
      <span>After .smf, pick folder to resolve assets</span>
    </label>

    <div class="status warn" v-if="error">Error: {{ error }}</div>
  </div>
</template>

<style scoped>
.section {
  margin-bottom: 16px;
}
h3 {
  margin: 0 0 8px;
  font-size: 1rem;
  color: #9fb0ff;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 6px 10px;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #1b1d22;
  color: #e6e6e6;
  margin-right: 8px;
  margin-bottom: 6px;
}
.file input[type="file"] {
  display: none;
}
.status.warn {
  color: #ff7676;
}
</style>
