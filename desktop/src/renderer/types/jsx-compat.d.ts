/**
 * React 19 removed the ambient global `JSX` namespace (it moved to
 * `React.JSX`). Existing components annotate return types as `JSX.Element`;
 * restore the global alias instead of touching every file.
 */
import type * as React from 'react'

declare global {
  namespace JSX {
    type Element = React.JSX.Element
    type ElementType = React.JSX.ElementType
    interface ElementClass extends React.JSX.ElementClass {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  }
}

export {}
