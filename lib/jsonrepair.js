"use strict";
// ── LLM이 뱉은 JSON 살려내기 ──────────────────────────────────────────────────
// 긴 JSON(1.5만~2만 자)을 한 번에 생성시키면 모델이 이따금 문법을 틀린다. 실측된 두 유형:
//
//  ① 문자열 안의 이스케이프 안 된 따옴표
//     {"explanation":"저자들은 "attention"을 …"}   ← 여기서 문자열이 일찍 끝나버린다
//     증상: Expected ',' or '}' after property value  /  Expected ',' or ']' after array element
//     (값을 다 읽은 뒤 구분자가 아닌 게 나왔다는 뜻 — 조기 종료된 문자열의 전형)
//
//  ② 응답 앞뒤에 잡설이 붙거나 앞부분이 잘려 나감
//     첫 '{' ~ 마지막 '}' 로 자르는 단순 방식은 이때 오히려 쓰레기를 만든다.
//     예: '…64개"},{"symbol":"d",…}]},{"latex":…' → 첫 '{' 가 중간 객체라 파싱이 깨진다.
//
// 이 모듈은 문자열/이스케이프를 인식하는 상태 기계로 ①을 고치고 ②는 균형 잡힌 객체를
// 찾아 해결한다. 재시도는 사용량을 그만큼 더 쓰므로, 고칠 수 있는 건 로컬에서 고친다.

// 이스케이프 시퀀스로 유효한 문자들 (JSON 명세)
const VALID_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
// 문자열이 정상적으로 끝났다면 그다음(공백 제외)은 반드시 이 중 하나다
const CLOSERS = new Set([",", ":", "}", "]"]);

/**
 * 텍스트에서 균형 잡힌 JSON 객체 하나를 잘라낸다.
 * 중괄호를 셀 때 문자열 안의 { } 는 세지 않는다 — 설명문에 중괄호가 흔하기 때문
 * (LaTeX \mathcal{L} 등). 여러 후보가 있으면 가장 긴 것을 고른다.
 * @returns {string|null}
 */
function extractJsonObject(text) {
  let best = null;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const cand = text.slice(start, i + 1);
          if (!best || cand.length > best.length) best = cand;
          break;
        }
      }
    }
    if (best && best.length > text.length / 2) break; // 충분히 크면 더 볼 필요 없음
  }
  return best;
}

/**
 * 흔한 LLM JSON 오류를 고친다.
 *  · 문자열 안의 이스케이프 안 된 " → \"
 *  · 잘못된 이스케이프(\m 같은 것) → \\m
 *  · } ] 앞의 트레일링 콤마 제거
 * 문자열 밖에서만 구조를 건드리므로 정상 JSON은 그대로 통과한다.
 */
function repairJson(text) {
  let out = "";
  let inStr = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (!inStr) {
      if (c === '"') { inStr = true; out += c; continue; }
      // 트레일링 콤마: , 다음 공백을 건너뛰고 } 나 ] 면 콤마를 버린다
      if (c === ",") {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === "}" || text[j] === "]") continue;
      }
      out += c;
      continue;
    }

    // ── 문자열 안 ──
    if (c === "\\") {
      const n = text[i + 1];
      if (VALID_ESCAPE.has(n)) { out += c + n; i++; }
      else { out += "\\\\"; }        // \m 같은 무효 이스케이프 → 백슬래시를 살린다
      continue;
    }
    if (c === '"') {
      // 정상 종료 따옴표인지 판별: 다음 비공백 문자가 , : } ] 또는 끝이면 종료로 본다
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j >= text.length || CLOSERS.has(text[j])) { inStr = false; out += c; }
      else { out += '\\"'; }          // 그 외 = 본문에 섞인 따옴표 → 이스케이프
      continue;
    }
    // 문자열 안의 생 줄바꿈·탭도 JSON에서는 불법이라 이스케이프한다
    if (c === "\n") { out += "\\n"; continue; }
    if (c === "\r") { out += "\\r"; continue; }
    if (c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  return out;
}

/**
 * 모델 응답에서 JSON 객체를 얻는다. 엄격 파싱 → 객체 추출 → 복구 순으로 시도한다.
 * 어느 단계에서 살아났는지 알 수 있게 마지막 성공 방식을 stage로 돌려준다.
 * @returns {{data: object, stage: "strict"|"extract"|"repair"}}
 * @throws 마지막 파싱 오류
 */
function parseLenient(raw) {
  let text = String(raw || "").trim();

  // ```json ... ``` 펜스 제거
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();

  try {
    return { data: JSON.parse(text), stage: "strict" };
  } catch (e0) {
    const obj = extractJsonObject(text);
    if (obj) {
      try {
        return { data: JSON.parse(obj), stage: "extract" };
      } catch (e1) {
        try {
          return { data: JSON.parse(repairJson(obj)), stage: "repair" };
        } catch (e2) {
          throw e2;
        }
      }
    }
    try {
      return { data: JSON.parse(repairJson(text)), stage: "repair" };
    } catch (e3) {
      throw e0; // 원래 오류가 진단에 더 유용하다
    }
  }
}

module.exports = { parseLenient, repairJson, extractJsonObject };
