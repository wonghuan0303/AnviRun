<script setup lang="ts">
import { RouterView } from 'vue-router';

import { useAppStore } from '@/stores/app';

const appStore = useAppStore();
</script>

<template>
  <div class="app-shell">
    <header class="app-shell__header">
      <h1 class="app-shell__title">{{ appStore.appName }}</h1>
    </header>
    <main class="app-shell__main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.app-shell__header {
  padding: 16px 24px;
  background-color: #ffffff;
  border-bottom: 1px solid #dcdfe6;
}

.app-shell__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.app-shell__main {
  flex: 1;
  padding: 24px;
}
</style>
