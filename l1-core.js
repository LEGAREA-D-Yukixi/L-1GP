// ============================================================
// L-1グランプリ 共有ロジック（純粋関数のみ / ブラウザ・Node両用）
// index.html / admin.html / test_l1.mjs から import される
// ============================================================

/** 'YYYY-MM-DD' をUTC日付として安全にパース（タイムゾーンずれ防止） */
export function parseISODate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** ±記号付きポイント表記 */
export function formatPoints(n) {
  const v = Number(n) || 0;
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * ブラックアウト判定:
 * 「最終ポイント表示月の前月扱い＝シーズン最終月（2月・8月）は集計情報を隠す」
 * → todayがシーズン終了月（ends_onと同じ年月）の初日〜ends_onの間ならtrue
 */
export function isBlackout(season, todayISO) {
  if (!season) return false;
  const today = parseISODate(todayISO);
  const end = parseISODate(season.ends_on);
  const start = parseISODate(season.starts_on);
  if (!today || !end || !start) return false;
  if (today < start || today > end) return false; // シーズン期間外（終了後は結果公開）
  const blackoutStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return today >= blackoutStart;
}

/** todayが属するシーズンを返す（重複時は開始日が新しいものを優先） */
export function seasonForDate(seasons, todayISO) {
  const today = parseISODate(todayISO);
  if (!today) return null;
  const hit = (seasons || [])
    .filter(s => {
      const st = parseISODate(s.starts_on);
      const en = parseISODate(s.ends_on);
      return st && en && today >= st && today <= en;
    })
    .sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1));
  return hit[0] || null;
}

/**
 * シーズン順位集計。
 * events: [{division_id, points, voided_at}] （対象シーズンのもののみ渡す）
 * divisions: [{id, name, display_order, is_active}]
 * 戻り値: pointsの降順・同点は同順位（1,1,3方式）
 */
export function calcStandings({ season, divisions, events, baseByDivision = null }) {
  const seasonBase = season && Number.isFinite(Number(season.initial_points))
    ? Number(season.initial_points) : 1000;
  const totals = new Map();
  for (const d of divisions || []) {
    if (d.is_active === false) continue;
    // baseByDivision が渡された場合は Division ごとの持ち越し基点を採用（通期での持ち越し）
    const base = baseByDivision && baseByDivision.has(d.id) ? Number(baseByDivision.get(d.id)) : seasonBase;
    totals.set(d.id, { division_id: d.id, name: d.name, display_order: d.display_order ?? 0, points: base, event_count: 0 });
  }
  for (const e of events || []) {
    if (e.voided_at) continue;
    const row = totals.get(e.division_id);
    if (!row) continue; // 非表示Divisionのイベントは集計対象外
    row.points += Number(e.points) || 0;
    row.event_count += 1;
  }
  const rows = [...totals.values()].sort(
    (a, b) => b.points - a.points || a.display_order - b.display_order || String(a.name).localeCompare(String(b.name), 'ja')
  );
  let rank = 0, prev = null;
  rows.forEach((r, i) => {
    if (prev === null || r.points !== prev) { rank = i + 1; prev = r.points; }
    r.rank = rank;
  });
  return rows;
}

/** eventsBySeason（Map or plain object）から season_id のイベント配列を取り出す */
function eventsOf(eventsBySeason, sid) {
  return (eventsBySeason instanceof Map ? eventsBySeason.get(sid) : (eventsBySeason || {})[sid]) || [];
}

/**
 * 持ち越し集計。
 * season.carryover_from が設定されていれば、そのシーズンの最終ポイントを
 * Division ごとの基点として引き継ぎ、当該シーズンのイベントを積み上げる（通期でポイントを保持）。
 * carryover_from が null の場合は初期ポイント（1,000L）からスタート。
 * 連鎖（前半戦 → 後半戦 → …）を root からたどって累積する。
 */
export function calcStandingsCarry({ season, seasons, divisions, eventsBySeason }) {
  if (!season) return calcStandings({ season, divisions, events: [] });
  const byId = new Map((seasons || []).map(s => [s.id, s]));

  // root → … → season の連鎖を作る（循環・過剰深度はガード）
  const chain = [];
  const guard = new Set();
  let cur = season, depth = 0;
  while (cur && !guard.has(cur.id) && depth < 50) {
    chain.unshift(cur);
    guard.add(cur.id);
    cur = cur.carryover_from ? byId.get(cur.carryover_from) : null;
    depth++;
  }

  let baseByDivision = null;
  let rows = [];
  for (const s of chain) {
    rows = calcStandings({ season: s, divisions, events: eventsOf(eventsBySeason, s.id), baseByDivision });
    baseByDivision = new Map(rows.map(r => [r.division_id, r.points]));
  }
  return rows;
}

/**
 * 年間集計（通期）。
 * ポイントは半期リセットせず通期で持ち越すため、年間 = そのサイクルの
 * 「終端シーズン（他シーズンから持ち越されない末端）」の持ち越し累積ポイント。
 * = 初期1,000L + サイクル内の全イベント。
 */
export function calcAnnualStandings({ cycle, seasons, divisions, eventsBySeason }) {
  const cyc = (seasons || []).filter(s => s.cycle === cycle);
  const referenced = new Set(cyc.map(s => s.carryover_from).filter(Boolean));
  let terminals = cyc.filter(s => !referenced.has(s.id));
  if (terminals.length === 0) terminals = cyc; // フォールバック
  const terminal = terminals.slice().sort((a, b) => (a.ends_on < b.ends_on ? 1 : -1))[0];

  if (!terminal) {
    // 対象サイクルにシーズンがない場合は全Division 0
    const rows = (divisions || []).filter(d => d.is_active !== false)
      .map(d => ({ division_id: d.id, name: d.name, display_order: d.display_order ?? 0, points: 0 }))
      .sort((a, b) => a.display_order - b.display_order);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }
  return calcStandingsCarry({ season: terminal, seasons, divisions, eventsBySeason });
}

/** 年間タブを隠すべきか: 対象cycle内のいずれかのシーズンが現在ブラックアウト中ならtrue */
export function isAnnualBlackout({ cycle, seasons }, todayISO) {
  return (seasons || []).some(s => s.cycle === cycle && isBlackout(s, todayISO));
}

/**
 * 申請フォーム入力のバリデーション（クライアント側。サーバー側トリガーと同等仕様）
 * 戻り値: { ok, errors[], points } — pointsは登録に使う正規化済み値
 */
export function validateRequestInput(input, rule) {
  const errors = [];
  if (!rule) errors.push('項目を選択してください');
  if (!input || !input.division_id) errors.push('Divisionを選択してください');
  const name = (input?.requester_name ?? '').trim();
  if (!name) errors.push('申請者名を入力してください');
  if (name.length > 100) errors.push('申請者名は100文字以内で入力してください');
  const dt = parseISODate(input?.occurred_on ?? '');
  if (!dt) errors.push('発生日を正しく入力してください（YYYY-MM-DD）');
  if ((input?.note ?? '').length > 2000) errors.push('詳細は2000文字以内で入力してください');

  let points = null;
  if (rule) {
    if (rule.is_variable) {
      const raw = input?.points;
      const v = typeof raw === 'number' ? raw : parseInt(String(raw ?? '').trim(), 10);
      if (!Number.isInteger(v) || v === 0) {
        errors.push('ポイントを入力してください（0以外の整数）');
      } else if (rule.kind === 'add' && v < 0) {
        errors.push('加点項目のポイントは正の値で入力してください');
      } else if (rule.kind === 'deduct' && v > 0) {
        errors.push('減点項目のポイントは負の値で入力してください');
      } else if (Math.abs(v) > 100000) {
        errors.push('ポイントが大きすぎます');
      } else {
        points = v;
      }
    } else {
      points = rule.points; // 固定ルールはマスタ値
    }
  }
  return { ok: errors.length === 0, errors, points };
}

/** ルールを 加点/減点 でグルーピング（表示順ソート済み） */
export function groupRules(rules) {
  const act = (rules || []).filter(r => r.is_active !== false)
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  return {
    add: act.filter(r => r.kind === 'add'),
    deduct: act.filter(r => r.kind === 'deduct'),
  };
}

/** イベントフィード整形（公開側: noteなしカラムのみ想定・void除外・日付降順） */
export function buildFeed({ events, divisions, rules, limit = 50 }) {
  const dmap = new Map((divisions || []).map(d => [d.id, d]));
  const rmap = new Map((rules || []).map(r => [r.id, r]));
  return (events || [])
    .filter(e => !e.voided_at)
    .sort((a, b) =>
      (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0) ||
      (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit)
    .map(e => {
      const r = rmap.get(e.rule_id);
      return {
        id: e.id,
        occurred_on: e.occurred_on,
        division_name: dmap.get(e.division_id)?.name ?? '(不明)',
        category: r?.category ?? '(不明)',
        label: r?.label ?? '',
        kind: r?.kind ?? (Number(e.points) >= 0 ? 'add' : 'deduct'),
        points: Number(e.points) || 0,
        points_label: formatPoints(e.points),
      };
    });
}

/** シーズン切替（管理画面用）: 現activeをfalse→対象をtrueの2段更新の順序を返す */
export function seasonActivationPlan(seasons, targetSeasonId) {
  const current = (seasons || []).filter(s => s.is_active && s.id !== targetSeasonId);
  return {
    deactivate: current.map(s => s.id),
    activate: targetSeasonId,
  };
}
