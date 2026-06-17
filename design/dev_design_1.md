# 으리챗 난투전 — 개발 기획서 (as-built)

> **이 문서는 "어떻게 구현하는가"**(데이터 구조·연출 아키텍처·온라인 동기화)를 다룬다.
> 게임 규칙·재미·캐릭터·밸런스 등 "무엇을, 왜"는 별도 **컨셉 기획서(concept_design.md)** 참조.
> **`index.html`이 항상 정답** — 이 문서는 코드 이후에 현행화한다.

> **문서 분리 이력**: v10 통합 기획서를 컨셉/개발 둘로 분리. 카드 목록·캐릭터 콘텐츠는 컨셉서가 원본, 본 문서는 구현 스펙·데이터·아키텍처가 원본.
> **현행화 (index.html v0.10.2 기준)**: ①5d 죽은 코드 정리 **완료**(고립 7함수 제거) ②캐릭터 카드 이미지 슬롯(`img` 필드 + `charImgHtml`, URL 미정 시 이모지 placeholder) 추가 ③카드 아이콘(`CARD_ICON`) 추가 ④HEAL 대상 선택(`buildHealQueue`의 `healTarget`) 반영.

---

## 1. 게임 상태 데이터 구조

> 온라인 멀티의 90%는 "이 객체를 어떻게 주고받느냐"의 문제. Firebase에 통째로 올리고 동기화한다.

```json
{
  "roomId": "ABCD",
  "phase": "playing",          // waiting | playing | finished
  "turnOrder": ["p1","p2","p3","p4"],
  "currentTurnIndex": 0,
  "action": null,              // 진행 중 액션 큐 (5장)
  "players": {
    "p1": { "name":"철수", "characterId":"choi", "hp":50, "alive":true,
            "hand":["kalbang","painkill","mirror","cook","protein"] }
  },
  "log": [ "p1 → p3 공격(칼빵 5)", "p3 무지개 반사 → p1 5 피해" ],
  "winner": null,
  "voided": false
}
```

> 모든 클라이언트는 이 객체 하나만 본다. "내가 AP인가? → 행동 UI", "action.await.target이 나인가? → 반응 UI" 식으로 화면이 전부 상태에서 파생된다.

---

## 2. 카드 데이터 스펙

> 카드 **목록 자체**는 컨셉 기획서 7-3이 원본. 여기선 구현용 컬럼 정의와 처리 규칙.

### 2-1. 컬럼 정의
| 컬럼 | 값 | 의미 |
|---|---|---|
| index | 정수 | 고유 번호 |
| Name | 문자열 | 이름 |
| Type | ATK / DEF / HEAL / ALL / REFLECT / Bounce | 동작 |
| Value | 정수 | 기본 수치. Bounce는 0 |
| Probability | 0~1 | 명중 확률 |
| Timing | MyTurn / OnHit | DEF·REFLECT·Bounce=OnHit, 그 외 MyTurn |
| Trigger | 캐릭터명/없음 | 보너스 받는 캐릭터 |
| Plus Type | ProbabilityUP / ValueUP / HEAL / Target | 보너스 종류 |
| Plus Value | 정수/소수 | 보너스 크기 |

> **코드상 카드 키**(`CARD_DEFS`): `munchi`(뭉치 짖기), `kalbang`(칼빵), `cook`(요리하기), `painkill`(진통제), `protein`(프로틴), `mirror`(무지개 반사), `bounce`(유수암쇄권).
> **아이콘**(`CARD_ICON`): 🐕 🔪 🍳 💊 💪 🌈 🥋, 미정의 시 🃏. `TYPE_TIMING` 상수가 Type→Timing을 파생.

### 2-2. 명중/반응 처리 규칙
- **명중 판정**: `Probability`로 굴림. 빗나가면 데미지 0, 카드 소모.
- **ALL**: 대상마다 개별 명중 판정.
- **피격 응답(한 종류만)**: 방어 누적 / 반사 / 튕기기 / 맞기. 방어와 반사·튕기기 혼용 금지.
- **연쇄 허용**: 되받아친 데미지에 다시 응답 가능(반사·튕기기·방어). ALL도 반사·튕기기 가능, 되받아치기는 단일 대상. 튕기기 본인 귀환 시 즉시 맞기.
- **종료 조건**: 응답 카드 없음 / 맞기 / 사망 / 안전 상한 20회.
- **카드 보충 타이밍**: 카드 사용 즉시가 아니라 **한 행동(연쇄 포함) 완전 종료 후** 1회 정산. 연쇄 중 손패 고정.

### 2-3. 캐릭터 데이터 구조
```json
"characters": {
  "choi":    { "name":"최초", "trigger":{"item":"dagger","on":"attack"}, "effect":{"type":"bonusDamage","value":4} },
  "gijong":  { "name":"기종", "trigger":{"item":"armor","on":"defend"},  "effect":{"type":"bonusDefense","value":10} },
  "gyuhyung":{ "name":"규형", "trigger":{"item":"shield","on":"reflect"},"effect":{"type":"reflectBonus","value":8} },
  "jiwon":   { "name":"지원", "trigger":{"item":"luck","on":"use"},      "effect":{"type":"drawOnUse","value":1} },
  "somin":   { "name":"소민", "trigger":{"item":"shield","on":"defend"}, "effect":{"type":"drawOnUse","value":1} },
  "junhyung":{ "name":"준형", "trigger":{"item":"bow","on":"attack"},    "effect":{"type":"pierce","value":1} },
  "jongmun": { "name":"종문", "trigger":{"item":"potion","on":"use"},    "effect":{"type":"healOnUse","value":10} },
  "jongwon": { "name":"종원", "trigger":{"item":"potion","on":"use"},    "effect":{"type":"healOnUse","value":15} },
  "hyunil":  { "name":"현일", "trigger":{"item":"sword","on":"attack"},  "effect":{"type":"bonusDamage","value":8} },
  "gihun":   { "name":"기훈", "trigger":{"item":"axe","on":"attack"},    "effect":{"type":"bonusDamage","value":15} }
}
```

### 2-4. 효과 적용 위치
- `on:"attack"` → 데미지 계산 시 보너스 가산.
- `on:"defend"` / `on:"reflect"` → 피격 응답 처리 시 적용.
- `on:"use"` → 행동 직후 드로우/회복 정산.
- 표준화(`type + value`)라 새 캐릭터는 데이터만 추가하면 됨.

### 2-5. 캐릭터 카드 이미지 슬롯 (v0.10.2 신규)
- `CHARACTERS` 각 항목에 `img` 필드. URL이 있으면 `<img class="char-img">`, 없으면 이모지 placeholder(🧑) 렌더(`charImgHtml`).
- 캐릭터 일러스트가 준비되면 `img`에 URL만 채우면 됨 — 코드 수정 불필요.
- 현재 트리거 배치 캐릭터는 5명(최초·종원·기종·현일·기훈), 나머지 5명은 "(트리거 미배치)" 표기.

---

## 3. 연출/진행 시스템 (이벤트 큐 + 재생기)

> 로직(누가 누구에게 얼마)과 연출(어떻게 보여주나)을 분리. 한 액션을 여러 단계로 쪼개 한 박자씩 재생.

### 3-1. 핵심 구조
1. **이벤트 생성**: 한 액션이 일으킬 일들을 순서대로 배열에 쌓음.
2. **재생기**: 큐를 하나씩 꺼내 화면에 표시, 입력 필요하면 멈추고, 자동이면 0.8~1.2s 뒤 다음.

```javascript
const queue = [
  { kind:"announce", actor:"ai3", card:"kalbang", target:"you" },
  { kind:"hitcheck", target:"you", prob:1 },
  { kind:"askDefense", target:"you", incoming:5 },   // 입력 대기
  { kind:"react", actor:"you", card:"mirror" },
  { kind:"damage", target:"ai3", amount:5, label:"반사" },
];
```

> 이 구조가 그대로 온라인으로 간다: owner가 queue를 계산해 DB에 올리면 전원이 동일 재생.

### 3-2. 이벤트 종류 (kind)
| kind | 의미 | 멈춤 |
|---|---|---|
| announce | 시전자·카드·대상 표시 | 자동 |
| hitcheck | 명중 굴림, 실패 시 MISS | 자동 |
| askDefense | 피격 응답 요청 | **입력 대기** |
| react | 대응 표시(막음/반사/떠넘김) | 자동 |
| damage | 데미지 숫자 | 자동 |
| selfheal | 회복 연출 (자신 포함 대상 1명, `buildHealQueue`의 healTarget) | 자동 |
| counterAnnounce | 반사/튕기기 공수전환 | 자동 |
| clearCR / clearAll | 구역 초기화 | 자동 |
| restoreAllAnnounce | 전체공격 되받아치기 후 시퀀스 재개 | 자동 |

### 3-3. 전체공격(ALL) 단계별 처리
ALL은 대상 수만큼 흐름 반복. 한꺼번에 처리하지 않음.
```
announce("뭉치 짖기!")
 → [대상A] hitcheck→명중→askDefense→react→damage
 → [대상B] hitcheck→빗나감→MISS
 → [대상C] hitcheck→명중→askDefense→react→damage
 → 종료
```
대상이 반사를 쓰면 그 자리에 되받아치기 패턴이 splice 삽입되고, 원 전체공격은 취소되지 않고 남은 대상에게 계속(3-6).

### 3-4. 화면 레이아웃 — 3구역
```
┌──────────┬──────────┬──────────┐
│  왼쪽    │  중앙    │  오른쪽  │
│ 시전자   │ 피격자   │  결과    │
│ 행동카드 │ 대응카드 │ 데미지   │
└──────────┴──────────┴──────────┘
```
- 왼쪽: 시전 카드 + "시전자→대상"
- 중앙: 대응 카드(방어/반사/튕기기). 우선순위: 대응 카드 > 명중·빗나감 표시
- 오른쪽: 최종 데미지 / MISS
- 한 패턴 끝 → 3구역 비움 → 다음 패턴

### 3-5. "카드 클릭 → 재생" 흐름
- 내 턴: 카드 선택(대상 지명 필요 시 클릭) → 즉시 큐 재생.
- 재생 중 손패·버튼 비활성. askDefense에서만 해당 플레이어 입력 활성(손패 인라인 반응 바).

### 3-6. 반사·튕기기 공수전환 (큐 삽입)
피격자가 시전자로 역전 → 3구역을 새로 한 번 더 써서 "되받아치는 공격"을 별도 패턴으로 재생.
- **반사**: `[react → clearAll → counterAnnounce(B→A) → askDefense(A) → restoreAllAnnounce]` splice. 끝에 askDefense라 A가 다시 응답 → 연쇄.
- **튕기기**: 대상 수만큼 패턴 삽입. 대상은 생존자 중 랜덤. **baking**: 대상을 큐 생성 시점에 확정(재생 시점 재롤링 금지 → 온라인 결정성).
- **전체공격 중 끼어듦**: ALL 큐 `[A→B, A→C, A→D]`에서 `A→B` 처리 중 반사 발생 시 그 직후에 `[B→A]` 패턴 splice. 남은 `A→C, A→D` 보존.

---

## 4. 연쇄·방어중첩 구현

### 4-1. 방어 중첩
- 응답 UI에서 방어 카드 여러 장 누적 탭 → 완료.
- `최종데미지 = max(0, 들어온데미지 − Σ방어량)`. 쓴 카드 전부 소모.

### 4-2. 연쇄 — 큐 재귀 삽입
- 반사/튕기기 시 `[counterAnnounce → damage → askDefense]` splice.
- 끝에 askDefense가 붙어 받은 쪽이 또 응답 → 자연 재귀.
- 카드 보충은 연쇄 완전 종료 후 양쪽 1회. 연쇄 중 손패 고정 → 유한 자원이 종료 보장.

### 4-3. 안전 상한 20회
- 한 행동의 되받아치기 패턴 수 카운트.
- 20회 도달 시 21번째는 강제 "맞기" + "연쇄 종료!" 표시.
- 정상 플레이에선 손패(최대 6) 먼저 소진 → 도달 불가. 버그성 무한루프 방지용 최후 안전판.

### 4-4. 전체공격 중앙 표시
- ALL 처리 시 중앙에 명중("명중!")/빗나감("빗나감 💨").
- 대상이 반사/튕기기/방어로 응답하면 대응 카드가 중앙을 덮어씀(대응 카드 우선).

---

## 5. 온라인 구현 (as-built)

> 구상이 아니라 `index.html`에 실제 구현된 코드 기준. 코드 갱신 시 이 장을 먼저 현행화.

### 5-1. 네트워크 모델
- **백엔드**: Firebase Realtime DB. 방 = `rooms/{code}` 단일 객체. 전원이 `on('value')` 구독, 화면은 상태에서 파생.
- **권위 모델**: owner = 현재 AP. 행동자가 큐 빌드 + 랜덤 baking → DB 업로드 → 전원 동일 재생. 끊김 같은 무주공산만 별도 **복구 권위자**가 처리.
- **핵심 원칙**: 상태 변경(턴/HP/alive/phase/winner/host)은 owner 또는 복구 권위자의 **단일 원자 write**로만. 클라가 각자 바꾸면 desync.

### 5-2. DB 스키마 `rooms/{roomId}`
| 필드 | 내용 |
|---|---|
| host | 방장 uid. 게임 중엔 런타임 권한 없음(대기실 시작 버튼 + 👑). |
| phase | waiting / playing / finished |
| players/{uid} | { name, characterId, hp, alive, hand[] } |
| turnOrder | uid 배열 |
| currentTurnIndex | 현재 AP 인덱스. 모든 클라가 자기 턴 여부를 이것으로만 판정 |
| log / winner / voided | 로그 / 우승자 / 동시 전멸 무효 플래그 |
| action | 진행 중 액션 큐 (5-4) |
| presence/{uid} | { connected, lastSeen } — onDisconnect로 서버가 갱신 |
| createdAt | 방 생성 타임스탬프. 유령 방 정리 기준 |

### 5-3. 식별 / 세션
- `myUid`: `sessionStorage.euri_uid`. 새로고침해도 유지 → 복구의 키.
- 방 코드: 4자리 영숫자. 입장은 waiting & 4명 미만일 때만.

### 5-4. 액션 큐 동기화 (owner 권위)
- **진입**: owner 카드 확정 → `startOnlineAction` → 큐 빌드 → `claimAndUploadQueue`.
- **claim 트랜잭션**: "내가 진짜 AP인가 + 진행 중 action 없는가" 원자 재검증 후에만 `action = {seq, queue, version, await:null, input:null, done:false, ownerUid}` 업로드. → 동시 행동·중복 업로드 경합 차단.
- **재생**: 전원 `onRoomData`가 `action.seq` 증가 감지 → 동일 큐 재생.
- **피격 입력**: owner가 `action/await` 게시 → 타겟 클라 `watchAwait`가 인라인 반응 바 표시 → `submitOnlineInput`이 `action/input` 기록 → owner가 읽어 반응 이벤트 splice 후 resolved 표시.

### 5-5. 정산 — commitSettlement 단일 write
재생 종료 시 owner가 한 번의 update로 확정: 손패 보충 + currentTurnIndex(다음 생존자) + phase/winner/voided + action/done. 클라는 이 값만 보고 다음 턴. (패스는 onlinePass 트랜잭션.)

### 5-6. watchAwait — 재생 가드와 분리된 상설 리스너
피격 응답 UI는 `action/await`를 별도 상설 구독으로 처리(재생 루프 밖). 재생 중에도, 새로고침 직후에도 내 차례 UI가 안정적으로 뜨고, await 해제(resolve/owner 이탈 abort) 시 자동 닫힘. → owner가 반사로 자기 타겟이 되는 역전 상황 deadlock 방지.

### 5-7. 견고화 5a — 응답 타임아웃
`RESPONSE_TIMEOUT = 30000ms`. 미응답 시 owner가 자동 take로 resolve → 멈춤 방지. 타겟 클라엔 코스메틱 카운트다운.

### 5-8. 견고화 5b — 새로고침 복구
- `saveSession`이 sessionStorage에 room/name 저장. 로드 시 `tryRejoinOnline` 자동 복귀.
- 취소 조건: 방 없음 / 멤버 아님 / finished.
- **in-flight**: 복귀 시 onlineSeq를 현재 seq로 맞춰 재생 중복 방지. 끊긴 게 나(AP)였다면 묶인 모두를 풀기 위해 `action/done:true`로 취소(직전 상태 복귀).

### 5-9. presence (5c-1) — 끊김 감지
- `.info/connected` 구독 + `onDisconnect().set({connected:false, lastSeen:ServerValue.TIMESTAMP})`로 서버가 끊김 시각 기록. 재접속 시 자동 재무장.
- presence 노드는 players/action/commit과 분리된 별도 상설 리스너(`onlineReplaying` 가드 무관 → 재생 중에도 감지). UI에 🔌·흐림.

### 5-10. 끊김 처리 권위 모델 (5c-2 ~ 5c-4)
무주공산은 단일 복구 권위자가 처리.
- **`amRecoveryAuthority()`**: turnOrder상 첫 alive+connected 한 명만 시도(최적화).
- **진짜 보장 = 트랜잭션 재검증**: 실제 변경은 `rooms/{roomId}` 트랜잭션 안에서 전제(끊김·유예·alive) 재확인 후에만 commit. 중복·동시 시도 모두 abort. 멱등.
- **권위자 승계**: 권위자가 끊기면 다음 alive+connected가 자동 인수.

| 단계 | 유예 | 동작 | 트리거 |
|---|---|---|---|
| 5c-2 | SKIP_GRACE 5s | idle AP 끊김 → 턴 스킵(alive 불변) | checkAPRecovery → skipDisconnectedAP |
| 5c-3 | ABORT_GRACE 0s | 행동 중 owner 끊김 → action abort(done:true, await 클리어, 묶인 spectator 즉시 해제) | checkOwnerAbort → abortOwnerAction. 턴은 5c-2에 위임 |
| 5c-4 | ELIM_GRACE 30s | 끊김 지속 → 탈락(alive=false) + 승패 재계산 + host 이양 | checkElimination → eliminateDisconnected |

**5c-4 동시성 방어**:
- in-flight action(done===false) 중 탈락 보류(큐가 그 uid를 target 참조 중일 수 있음 → desync 방지). 5c-3가 즉시 abort하므로 보류 짧음.
- 다중 끊김은 한 트랜잭션에서 일괄 탈락. alive/winner/phase/currentTurnIndex/host를 한 write로만 변경.
- 복귀 race: 유예 중 재접속 시 타이머 취소 + 트랜잭션이 connected/lastSeen 최종 재검증 → 커밋 직전 복귀도 abort.

### 5-11. 승패 엣지 케이스
- **끊김으로 alive ≤ 1**: 1명이면 그 사람 우승. 동시 전멸(0명)이면 마지막에 끊긴 사람(lastSeen 최대) 우승.
- **전투로 alive = 0**(전체공격 등 HP 동시 0): `voided=true` → 승자 없음, 무효 처리.
- 구분: 끊김 경로 = 우승자 있음 / 전투 경로 = 무효.

### 5-12. 게임 종료 후 방 정리
- **sweepGhostRooms**: 새 방 생성 시 fire-and-forget. connected 아무도 없고 마지막 이탈 후 GHOST_GRACE(120s)/FIN_GRACE(10s) 경과한 방 삭제. 트랜잭션 멱등.
- **leaveRoomAndReload**: 승리 화면 나가기 → finished 방만 즉시 삭제 → 새로고침. 리스너 off 후 삭제.
- **rematchOnline**: 승리 화면 다시 하기 → finished 방을 waiting으로 리셋. 이름 유지, hp/alive/hand 제거, winner/voided 초기화, action seq 유지. 전원 대기실 복귀.

---

## 6. 개발 로드맵 / 남은 작업

### 6-1. 완료된 단계
1. 로컬 N인 완성 (턴 루프·아이템·반사·전체공격) ✅
2. 상태 객체 확정 ✅
3. Firebase 연결 (방 생성/입장/동기화) ✅
4. 턴·피격 동기화 (큐 네트워크화) — Stage 1~3 ✅
5. 견고화 — 5a 타임아웃·5b 새로고침·5c-1~4 끊김 처리 ✅
6. **5d 죽은 코드 정리 ✅** — 큐 엔진 도입 후 고립된 옛 경로(offerReaction, openReactModal, applyReaction, finishAction, onlineNextTurn, syncOnline, checkWinOnline, pendingAction 등) 제거 완료. 현 코드엔 잔재 없음.

### 6-2. 남은 것
- 미배치 캐릭터 5명(규형·지원·소민·준형·종문) 트리거 카드 추가.
- 캐릭터 카드 일러스트 URL 채우기(`CHARACTERS[].img` — 슬롯은 구현됨).
- (장기) 보안 규칙 하드닝(현재 presence 포함 .read/.write 개방).
- (선택) 승패 엣지: 끊긴(미탈락) 플레이어가 전투 동시 전멸 시 우승 후보가 되는 케이스 — connected 우선 규칙 검토(현재는 안 건드림).

### 6-3. 예외 처리 체크리스트 (구현 현황)
| 상황 | 처리 | 위치 |
|---|---|---|
| 응답 시간 초과 | 자동 맞기 | 5-7 |
| 접속 끊김 | 턴 스킵 / 30초 후 탈락 | 5-10 |
| 새로고침 | 상태 재로딩 | 5-8 |
| 동시 입력 충돌 | 트랜잭션 재검증 | 5-4 |
| 방장 나감 | 권한 이양 | 5-10 |
| 종료 후 방 | 즉시 삭제 + 주기 정리 | 5-12 |
