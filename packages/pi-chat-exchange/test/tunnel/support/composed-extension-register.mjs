import { register } from 'node:module';
register(new URL('./composed-extension-loader.mjs', import.meta.url));
