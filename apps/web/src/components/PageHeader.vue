<script setup lang="ts">
import { useRouter } from 'vue-router';

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    backText?: string;
    showBack?: boolean;
    backTo?: string | object;
  }>(),
  {
    description: '',
    backText: '返回',
    showBack: false,
    backTo: undefined,
  },
);

const emit = defineEmits<{
  back: [];
}>();

const router = useRouter();

function handleBack(): void {
  if (props.backTo) {
    void router.push(props.backTo);
  } else {
    emit('back');
    if (!props.backTo) {
      router.back();
    }
  }
}
</script>

<template>
  <div class="page-heading">
    <div class="page-heading__main">
      <div v-if="showBack" class="page-heading__back">
        <el-button link type="primary" class="back-btn" @click="handleBack">
          ← {{ backText }}
        </el-button>
      </div>
      <div class="page-heading__title-group">
        <h1 class="page-heading__title">{{ title }}</h1>
        <slot name="badge" />
      </div>
      <p v-if="description" class="page-heading__description">{{ description }}</p>
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="page-heading__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.page-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.page-heading__main {
  flex: 1;
  min-width: 0;
}

.page-heading__back {
  margin-bottom: 6px;
}

.back-btn {
  font-size: 13px;
  padding: 0;
}

.page-heading__title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.page-heading__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--ar-text-primary);
  letter-spacing: -0.02em;
}

.page-heading__description {
  margin: 4px 0 0;
  color: var(--ar-text-secondary);
  font-size: 13px;
}

.page-heading__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
