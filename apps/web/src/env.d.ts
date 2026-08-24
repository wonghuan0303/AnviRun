/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 服务端 API 基地址，例如 http://127.0.0.1:3000 */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
