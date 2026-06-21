/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone — Scroll Viewport Component
 *
 * A container that renders its children into a virtual buffer
 * and only displays the visible window, supporting scroll offsets.
 *
 * This enables chat history scrolling (pgUp/pgDn/Home/End)
 * within pi-tui's rendering model.
 */

import { type Component, Container, Spacer } from '@earendil-works/pi-tui';

export class ScrollViewport implements Component {
  children: Component[] = [];
  private _scrollOffset: number = 0; // 0 = bottom, positive = scrolled up
  private _cachedLines: string[] | null = null;
  private _cachedWidth: number = 0;

  /** Get current scroll offset (0 = bottom, positive = scrolled up) */
  get scrollOffset(): number {
    return this._scrollOffset;
  }

  /** Set scroll offset, clamped to valid range */
  set scrollOffset(value: number) {
    this._scrollOffset = Math.max(0, value);
    this._invalidateCache();
  }

  /** Scroll up by N lines (increase offset) */
  scrollUp(lines: number): void {
    this._scrollOffset = Math.max(0, this._scrollOffset + lines);
    this._invalidateCache();
  }

  /** Scroll down by N lines (decrease offset, 0 = bottom) */
  scrollDown(lines: number): void {
    this._scrollOffset = Math.max(0, this._scrollOffset - lines);
    this._invalidateCache();
  }

  /** Scroll to bottom (offset = 0) */
  scrollToBottom(): void {
    this._scrollOffset = 0;
    this._invalidateCache();
  }

  /** Check if scrolled up from bottom */
  get isScrolledUp(): boolean {
    return this._scrollOffset > 0;
  }

  addChild(component: Component): void {
    this.children.push(component);
    this._invalidateCache();
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
      this._invalidateCache();
    }
  }

  clear(): void {
    this.children = [];
    this._scrollOffset = 0;
    this._invalidateCache();
  }

  invalidate(): void {
    this._invalidateCache();
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  /**
   * Render children to full buffer, then slice the visible window.
   *
   * The viewport shows content from (totalLines - height - scrollOffset)
   * to (totalLines - scrollOffset).
   *
   * When scrollOffset is 0, we're at the bottom (latest messages).
   * When scrollOffset > 0, we're looking at older messages.
   *
   * Since we don't know the viewport height at render time, we
   * return the FULL buffer and let pi-tui handle the viewport.
   * But we trim the TOP of the buffer when scrolled up, so pi-tui
   * naturally shows the right portion at the bottom of the screen.
   */
  render(width: number): string[] {
    // Check cache
    if (this._cachedLines && this._cachedWidth === width) {
      return this._applyScroll(this._cachedLines);
    }

    // Render all children to get the full content
    const allLines: string[] = [];
    for (const child of this.children) {
      const childLines = child.render(width);
      for (const line of childLines) {
        allLines.push(line);
      }
    }

    // Cache
    this._cachedLines = allLines;
    this._cachedWidth = width;

    return this._applyScroll(allLines);
  }

  /**
   * Get the total number of rendered lines (before scroll windowing).
   * Useful for displaying scroll indicators.
   */
  getTotalLines(): number {
    return this._cachedLines?.length ?? 0;
  }

  private _applyScroll(allLines: string[]): string[] {
    if (this._scrollOffset <= 0) {
      return allLines;
    }

    // When scrolled up, we trim lines from the TOP of the buffer.
    // This means pi-tui's bottom-aligned rendering shows older content.
    // But we need to also keep bottom content visible if the buffer is
    // shorter than the viewport.
    //
    // The trick: we trim top lines equal to scrollOffset.
    // pi-tui renders from bottom, so trimming top makes the viewport
    // show content from further up in the history.
    const maxOffset = Math.max(0, allLines.length - 5); // Keep at least 5 lines visible
    const effectiveOffset = Math.min(this._scrollOffset, maxOffset);

    if (effectiveOffset === 0) {
      return allLines;
    }

    return allLines.slice(0, allLines.length - effectiveOffset);
  }

  private _invalidateCache(): void {
    this._cachedLines = null;
    this._cachedWidth = 0;
  }
}