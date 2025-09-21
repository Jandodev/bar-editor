<script setup lang="ts">
/**
 * Template-based tree explorer that delegates node rendering to FilesTreeNode.vue.
 * Keeps simple props/emits and avoids render-function complexity.
 */
export type UploadedEntry = {
  path: string
  url?: string
  isImage: boolean
  isDDS: boolean
  file?: File
}
export type TreeNode = {
  name: string
  path: string
  isDir: boolean
  children?: TreeNode[]
  entry?: UploadedEntry
}

const props = defineProps<{
  nodes: TreeNode[]
  expandedSet: Set<string>
  selectedPath: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle', path: string): void
  (e: 'select', path: string): void
  (e: 'parseMapinfo', entry: UploadedEntry): void
  (e: 'loadSmf', entry: UploadedEntry): void
  (e: 'overlay', entry: UploadedEntry): void
  (e: 'useAsBase', entry: UploadedEntry): void
}>()
</script>

<template>
  <div class="fe-root">
    <FilesTreeNode
      v-for="n in nodes"
      :key="n.path"
      :node="n"
      :expanded-set="expandedSet"
      :selected-path="selectedPath"
      @toggle="(p) => emit('toggle', p)"
      @select="(p) => emit('select', p)"
      @parseMapinfo="(e) => emit('parseMapinfo', e)"
      @loadSmf="(e) => emit('loadSmf', e)"
      @overlay="(e) => emit('overlay', e)"
      @useAsBase="(e) => emit('useAsBase', e)"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import FilesTreeNode from './FilesTreeNode.vue'

export default defineComponent({
  name: 'FilesExplorer',
  components: { FilesTreeNode },
})
</script>

<style scoped>
.fe-root {
  padding: 0;
}

/* Reuse explorer styles to match App.vue look */
.fb-node { margin-left: 0; }
.fb-children {
  margin-left: 16px;
  border-left: 1px dashed #2a2a2a;
}
.fb-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #22252c;
  user-select: none;
  cursor: default;
}
.fb-row:last-child { border-bottom: none; }

.fb-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #cfd4e6;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.twisty {
  display: inline-block;
  width: 16px;
  text-align: center;
  color: #9fb0ff;
  cursor: pointer;
}
.dir { color: #b8c6ff; font-weight: 600; }
.file { color: #d9e0ff; }
.fb-row.selected { background: #1a1c20; }
.fb-path .icon { color: #c0c4d4; }

.fb-tags {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.tag {
  background: #0f1115;
  border: 1px solid #2a2a2a;
  color: #9fb0ff;
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
}
button.small {
  padding: 4px 8px;
  font-size: 0.85rem;
}
</style>
