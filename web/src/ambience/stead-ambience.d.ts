// Types for the vanilla ambience module (stead-ambience.js).
export function mountMarketField(
  canvas: HTMLCanvasElement,
  opts?: { cell?: number; fps?: number; lens?: number; onRescue?: ((at: { col: number; row: number }) => void) | null },
): () => void;
export function powerOn(root?: ParentNode, opts?: { force?: boolean }): void;
export function rollNumbers(root?: ParentNode, opts?: { instant?: boolean; selector?: string }): void;
export function rollOnView(root?: ParentNode): void;
export function mountGlyphMark(canvas: HTMLCanvasElement, opts?: { cell?: number; fps?: number }): () => void;
