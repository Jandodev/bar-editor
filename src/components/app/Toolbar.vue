<script setup lang="ts">
// Simple top toolbar placeholder; actions can be slotted in later.
</script>

<template>
  <div class="toolbar">
    <div class="title">BAR Map Editor</div>
    <div class="spacer" />
    <div class="actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid #222;
  background: #0f1115;
  color: #e6e6e6;
}
.title {
  font-weight: 600;
  color: #b8c6ff;
}
.spacer {
  flex: 1 1 auto;
}
.actions :deep(button) {
  margin-left: 8px;
}
</style>
