<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    type?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
  }>(),
  {
    hint: '',
    type: 'default',
  },
);
</script>

<template>
  <div class="metric-card" :class="[`metric-card--${type}`]">
    <div class="metric-card__header">
      <span class="metric-card__label">{{ label }}</span>
      <slot name="icon" />
    </div>
    <div class="metric-card__value">{{ value }}</div>
    <div v-if="hint || $slots.hint" class="metric-card__hint">
      <slot name="hint">{{ hint }}</slot>
    </div>
  </div>
</template>

<style scoped>
.metric-card {
  background: var(--ar-bg-card);
  border: 1px solid var(--ar-border-color);
  border-radius: var(--ar-radius-lg);
  padding: 16px 20px;
  box-shadow: var(--ar-shadow-xs);
  transition: var(--ar-transition-base);
}

.metric-card:hover {
  box-shadow: var(--ar-shadow-sm);
  border-color: var(--ar-border-dark);
}

.metric-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.metric-card__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--ar-text-secondary);
}

.metric-card__value {
  font-size: 24px;
  font-weight: 700;
  color: var(--ar-text-primary);
  line-height: 1.2;
}

.metric-card__hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ar-text-muted);
}

/* Variant styles */
.metric-card--primary .metric-card__value {
  color: var(--ar-color-primary);
}
.metric-card--success .metric-card__value {
  color: var(--ar-status-success);
}
.metric-card--warning .metric-card__value {
  color: var(--ar-status-warning);
}
.metric-card--danger .metric-card__value {
  color: var(--ar-status-danger);
}
</style>
