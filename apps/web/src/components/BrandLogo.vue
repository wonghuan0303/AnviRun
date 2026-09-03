<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: 'small' | 'default' | 'large';
    showSubtitle?: boolean;
    dark?: boolean;
  }>(),
  {
    size: 'default',
    showSubtitle: false,
    dark: false,
  },
);
</script>

<template>
  <div class="brand-logo" :class="[`brand-logo--${size}`, { 'brand-logo--dark': dark }]">
    <svg
      class="brand-logo__icon"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <!-- Anvil silhouette base -->
      <rect width="32" height="32" rx="6" fill="currentColor" class="brand-logo__bg" />
      <path
        d="M8 10C8 9.44772 8.44772 9 9 9H23C23.5523 9 24 9.44772 24 10V12C24 12.5523 23.5523 13 23 13H21.5C20.1193 13 19 14.1193 19 15.5V17H21C21.5523 17 22 17.4477 22 18V21C22 21.5523 21.5523 22 21 22H11C10.4477 22 10 21.5523 10 21V18C10 17.4477 10.4477 17 11 17H13V15.5C13 14.1193 11.8807 13 10.5 13H9C8.44772 13 8 12.5523 8 12V10Z"
        fill="#FFFFFF"
      />
      <!-- Forge spark accent -->
      <circle cx="21.5" cy="10.5" r="1.5" fill="#F97316" />
      <path
        d="M19 7L20 8.5L21.5 8L20.5 9.5L22 11L20 10.5L19 12L19 10L17.5 9.5L19 8.5V7Z"
        fill="#FDBA74"
      />
    </svg>
    <div class="brand-logo__text">
      <span class="brand-logo__name">AnvilRun</span>
      <span v-if="showSubtitle" class="brand-logo__tagline">铸程 · 构建服务平台</span>
    </div>
  </div>
</template>

<style scoped>
.brand-logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  color: var(--ar-text-primary);
  line-height: 1.2;
}

.brand-logo--dark {
  color: #ffffff;
}

.brand-logo__bg {
  color: #c2410c;
}

.brand-logo--small .brand-logo__icon {
  width: 22px;
  height: 22px;
}
.brand-logo--small .brand-logo__name {
  font-size: 14px;
}

.brand-logo--default .brand-logo__icon {
  width: 28px;
  height: 28px;
}
.brand-logo--default .brand-logo__name {
  font-size: 16px;
  letter-spacing: -0.01em;
}

.brand-logo--large .brand-logo__icon {
  width: 38px;
  height: 38px;
}
.brand-logo--large .brand-logo__name {
  font-size: 22px;
  letter-spacing: -0.02em;
}

.brand-logo__text {
  display: flex;
  flex-direction: column;
}

.brand-logo__tagline {
  font-size: 11px;
  font-weight: 400;
  color: var(--ar-text-secondary);
  margin-top: 2px;
}

.brand-logo--dark .brand-logo__tagline {
  color: var(--ar-color-slate-400);
}
</style>
