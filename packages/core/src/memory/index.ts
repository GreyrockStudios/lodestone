/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/**
 * Lodestone Core — Memory System
 *
 * Three-layer memory: Wiki (curated knowledge), Vector (semantic recall),
 * Scratch (session-scoped state). Knowledge compounds across sessions.
 *
 * Design principles:
 * 1. Wiki is the source of truth — curated, cross-linked, linted
 * 2. Vector memory is for fast recall — facts, preferences, decisions
 * 3. Scratch buffer is for session continuity — survives context compaction
 * 4. Never auto-resolve contradictions — surface them
 */

export { WikiStore } from './wiki-store.js';
export { VectorMemory } from './vector-memory.js';
export { ScratchBuffer } from './scratch-buffer.js';
export { MemorySystem } from './memory-system.js';