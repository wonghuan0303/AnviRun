<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: 'success' | 'warning' | 'danger' | 'info' | 'primary';
    text: string;
    pulse?: boolean;
    size?: 'small' | 'default' | 'large';
  }>(),
  {
    type: 'info',
    pulse: false,
    size: 'default',
  },
);
</script>

<template>
  <span class="status-badge" :class="[`status-badge--${type}`, `status-badge--${size}`]">
    <span class="status-badge__dot" :class="{ 'status-badge__dot--pulse': pulse }" />
    <span class="status-badge__text">{{ text }}</span>
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: var(--ar-radius-full);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  border: 1px solid transparent;
}

.status-badge--small {
  padding: 1px 6px;
  font-size: 11px;
  gap: 4px;
}

.status-badge--large {
  padding: 4px 12px;
  font-size: 13px;
  gap: 8px;
  font-weight: 600;
}

.status-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: currentColor;
  flex-shrink: 0;
}

.status-badge--large .status-badge__dot {
  width: 8px;
  height: 8px;
}

.status-badge__dot--pulse {
  animation: pulse-ring 1.8s cubic-bezier(0.24, 0, 0.38, 1) infinite;
}

@keyframes pulse-ring {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 currentColor;
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 4px transparent;
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 transparent;
  }
}

/* Status variants */
.status-badge--success {
  background-color: var(--ar-status-success-bg);
  color: var(--ar-status-success-text);
  border-color: var(--ar-status-success-border);
}

.status-badge--warning {
  background-color: var(--ar-status-warning-bg);
  color: var(--ar-status-warning-text);
  border-color: var(--ar-status-warning-border);
}

.status-badge--danger {
  background-color: var(--ar-status-danger-bg);
  color: var(--ar-status-danger-text);
  border-color: var(--ar-status-danger-border);
}

.status-badge--info {
  background-color: var(--ar-status-info-bg);
  color: var(--ar-status-info-text);
  border-color: var(--ar-status-info-border);
}

.status-badge--primary {
  background-color: var(--ar-color-primary-subtle);
  color: var(--ar-color-primary-text);
  border-color: #fed7aa;
}
</style>
