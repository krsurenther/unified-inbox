// Minimal ambient types for `qrcode` (the package ships none) — just the calls we use.
declare module 'qrcode' {
  interface QrOptions {
    width?: number;
    margin?: number;
    type?: string;
  }
  export function toDataURL(text: string, opts?: QrOptions): Promise<string>;
  export function toFile(path: string, text: string, opts?: QrOptions): Promise<void>;
  export function toString(text: string, opts?: QrOptions): Promise<string>;
  const _default: {
    toDataURL: typeof toDataURL;
    toFile: typeof toFile;
    toString: typeof toString;
  };
  export default _default;
}
