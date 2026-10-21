import { DriverMode } from '../types';

/**
 * Returns a user-facing reason why serial access is unavailable for the given
 * driver mode, or null if it should work. Native mode needs Web Serial; the
 * polyfill needs WebUSB. Safari and Firefox support neither.
 */
export const getSerialUnsupportedReason = (mode: DriverMode = DriverMode.AUTO): string | null => {
  const hasNative = 'serial' in navigator;
  const hasUsb = 'usb' in navigator;
  if (!window.isSecureContext) {
    return 'Serial access requires a secure context (HTTPS or localhost).';
  }
  if (mode === DriverMode.NATIVE && !hasNative) {
    return 'Web Serial API is not supported in this browser. Use Chrome or Edge on desktop.';
  }
  if (mode === DriverMode.POLYFILL && !hasUsb) {
    return 'WebUSB is not supported in this browser, so the polyfill driver cannot run. Use Chrome or Edge.';
  }
  if (mode === DriverMode.AUTO && !hasNative && !hasUsb) {
    return 'This browser supports neither Web Serial nor WebUSB (Safari and Firefox do not). Use Chrome or Edge on desktop.';
  }
  return null;
};
