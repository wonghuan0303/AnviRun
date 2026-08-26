import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { router } from './router';
import { useAuthStore } from './stores/auth';

import 'element-plus/dist/index.css';
import './styles/main.css';

const pinia = createPinia();
useAuthStore(pinia);

createApp(App).use(pinia).use(router).use(ElementPlus, { locale: zhCn }).mount('#app');
