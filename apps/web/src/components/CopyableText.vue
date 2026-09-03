<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';

const props = withDefaults(
  defineProps<{
    text: string;
    displayText?: string;
    code?: boolean;
    tooltip?: string;
  }>(),
  {
    displayText: '',
    code: true,
    tooltip: '点击复制',
  },
);

const copied = ref(false);

async function copy(): Promise<void> {
  if (!props.text) return;
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    ElMessage.success('已复制到剪贴板');
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    ElMessage.warning('复制失败，请手动选择复制');
  }
}
</script>

<template>
  <span class="copyable-text" :title="tooltip" @click="copy">
    <component :is="code ? 'code' : 'span'" class="copyable-text__content">
      {{ displayText || text }}
    </component>
    <span class="copyable-text__icon" :class="{ 'is-copied': copied }">
      <svg
        v-if="!copied"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        stroke="currentColor"
        stroke-width="2"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <svg
        v-else
        viewBox="0 0 24 24"
        width="14"
        height="14"
        stroke="currentColor"
        stroke-width="2"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  </span>
</template>

<style scoped>
.copyable-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: var(--ar-radius-sm);
  transition: var(--ar-transition-base);
  color: var(--ar-text-primary);
}

.copyable-text:hover {
  background-color: var(--ar-bg-subtle);
  color: var(--ar-color-primary);
}

.copyable-text__content {
  font-size: 13px;
}

.copyable-text__icon {
  display: inline-flex;
  align-items: center;
  opacity: 0.6;
  transition: var(--ar-transition-base);
}

.copyable-text:hover .copyable-text__icon {
  opacity: 1;
}

.copyable-text__icon.is-copied {
  color: var(--ar-status-success);
  opacity: 1;
}
</style>
