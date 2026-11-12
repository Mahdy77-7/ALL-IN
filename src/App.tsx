/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const APP_VERSION = 'v1.6.3';

export default function App() {
  return (
    <div
      data-version={APP_VERSION}
      className="fixed inset-0 w-full h-[100dvh] max-h-[100dvh] max-w-[100vw] overflow-hidden flex flex-col justify-between box-border select-none"
    ></div>
  );
}


