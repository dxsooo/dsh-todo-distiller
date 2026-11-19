// Types for DSH platform modules the browser bundle imports at runtime
// through the host's module table (scripts/build-client.mjs keeps them external).
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'
  /** DSH product icon in the sidebar's outline style. */
  export const IconChecklistOutlineRegular: ComponentType<{ size?: number }>
}
