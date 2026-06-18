// ── 순수 유틸 ─────────────────────────────────────────────────
import { CARD_KEYS } from './data/cards.js';

export function drawCard() { return CARD_KEYS[Math.floor(Math.random() * CARD_KEYS.length)]; }
export function newHand(n) { return Array.from({ length: n }, drawCard); }
export function rollHit(p) { return Math.random() < p; }
export function toArr(v) { return v ? (Array.isArray(v) ? v : Object.values(v)) : []; }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
