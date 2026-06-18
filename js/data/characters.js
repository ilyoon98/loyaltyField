// ── 캐릭터 정의 + 트리거 효과 계산 ────────────────────────────
import { CARD_DEFS } from './cards.js';

export const CHARACTERS = [
  { id:"최초", desc:"뭉치 짖기 명중률 ↑", img:null },
  { id:"종원", desc:"요리하기 회복량 ↑", img:null },
  { id:"기종", desc:"진통제 방어량 ↑", img:null },
  { id:"현일", desc:"프로틴 공격 시 회복", img:null },
  { id:"기훈", desc:"유수암쇄권 대상 ↑", img:null },
  { id:"규형", desc:"(트리거 미배치)", img:null },
  { id:"지원", desc:"(트리거 미배치)", img:null },
  { id:"소민", desc:"(트리거 미배치)", img:null },
  { id:"준형", desc:"(트리거 미배치)", img:null },
  { id:"종문", desc:"(트리거 미배치)", img:null },
];

// 캐릭터 카드 이미지 슬롯: img URL 있으면 <img>, 없으면 이모지 placeholder.
export function charImgHtml(c) {
  return c.img
    ? `<img class="char-img" src="${c.img}" alt="${c.id}">`
    : `<div class="char-img placeholder">🧑</div>`;
}

// 캐릭터 트리거 보너스 적용 (명중률/수치)
export function effProb(key, chr) {
  const d = CARD_DEFS[key]; let p = d.prob;
  if (d.trigger === chr && d.plusType === "ProbabilityUP") p += d.plusValue;
  return Math.min(1, p);
}
export function effValue(key, chr) {
  const d = CARD_DEFS[key]; let v = d.value;
  if (d.trigger === chr && d.plusType === "ValueUP") v += d.plusValue;
  return v;
}
