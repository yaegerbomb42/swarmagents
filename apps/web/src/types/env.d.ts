/// <reference types="next" />
/// <reference types="next/image-types/global" />

declare namespace NodeJS {
  interface ProcessEnv {
    ENGINE_URL?: string;
    NEXT_PUBLIC_ENGINE_URL?: string;
    BROWSER_BACKEND_URL?: string;
    OLLAMA_URL?: string;
    DEEPSEEK_V4_API_KEY?: string;
  }
}