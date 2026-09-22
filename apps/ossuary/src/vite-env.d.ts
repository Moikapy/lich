/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    ossuary?: {
      ready: true;
    };
  }
}
